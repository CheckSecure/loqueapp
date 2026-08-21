-- ==============================================================================================
-- 074 - DURABLE EVIDENCE THAT A WEEKLY BATCH WAS ACTUALLY RELEASED
--
-- ── THE DEFECT ────────────────────────────────────────────────────────────────────────────────
-- The member-facing countdown is computed from the calendar alone (thursdayBanner -> nextBatch),
-- so it rolls forward every Thursday whether or not anything was released. A clock is not evidence.
--
-- ── WHY NO EXISTING FIELD COULD BE REUSED ─────────────────────────────────────────────────────
--   1. NO TIMESTAMP EXISTS. introduction_batches carries `status` plus migration 018's algorithm
--      columns. There is no released_at or approved_at anywhere in the schema.
--   2. status='active' IS NOT A RELEASE MARKER. approve-batch flips it at route.ts:66, BEFORE the
--      materialisation loop at :129. A failed approval leaves a batch 'active' with zero cards.
--   3. A COLUMN WOULD NOT SURVIVE. delete-batch HARD-DELETES the row, and the weekly reciprocal
--      path releases cards with no introduction_batches row at all.
--
-- ── VISIBLE CARDS ARE NOT PROOF OF COMPLETION. THIS IS THE CENTRAL POINT. ─────────────────────
-- After the originating process ends, these two states are IDENTICAL in the database:
--
--     A. the loop finished normally, cards committed, the release insert failed
--     B. the loop CRASHED halfway, some cards committed, the insert was never attempted
--
-- Both show visible cards and no release row. So nothing may ever reconstruct "a release completed"
-- from cards, timestamps, batch status, counts, or the absence of an error recorded nowhere. Only
-- the writer itself knows it reached its end, and the ONLY moment that knowledge exists is inside
-- the call it makes after the loop. That call is public.finalize_weekly_release, and the immutable
-- row it writes is the sole evidence anything downstream is permitted to trust.
--
-- Consequently there is NO card-based reconciliation job anywhere, and this migration deliberately
-- adds no second "run" table: recovery is re-running the writer, whose work is already idempotent.
--
-- ── HOW A RUN IS ATTRIBUTED (and what could NOT be used) ──────────────────────────────────────
-- intro_requests.batch_id is the member's RECOMMENDATION_BATCHES envelope, not
-- introduction_batches.id, and no column on intro_requests references the review batch. So a card
-- CANNOT be traced to a review batch through intro_requests, and this migration does not pretend it
-- can. recommendation_batches.reciprocal_batch_id is also unusable: migration 064 records only which
-- producer FIRST created an envelope and deliberately never rewrites it on reuse.
--
-- What IS durable is public.batch_suggestions. Migration 064 stamps materialized_at = now() on
-- exactly the two review rows of a pair at the moment that pair lands (064:603), so
-- (batch_id, materialized_at) is a per-review-batch, per-instant record of what actually
-- materialised. That is the admin evidence, and it is exact.
--
-- The weekly reciprocal path has no batch of any kind. is_admin_initiated = false is NOT sufficient
-- to identify it - that flag is written by every non-admin producer, so onboarding cards would
-- qualify a weekly release. The durable discriminator is member_pairs.source, which
-- create_reciprocal_suggestion writes from p_source and constrains to
-- ('onboarding','weekly','admin_reciprocal','migration') (063:341).
--
-- WRITER INVENTORY, and what each puts in member_pairs.source:
--   weekly-refresh broad generation      generateReciprocalBatchForMember(id,'weekly')  -> 'weekly'
--   weekly-refresh COVERAGE generation   generateReciprocalBatchForMember(id,'weekly')  -> 'weekly'
--   onboarding (actions / profile.complete) ...(id,'onboarding')                        -> 'onboarding'
--   onboarding-retry-worker              ...(id,'onboarding_retry')                     -> 'onboarding'
--   admin recover-onboarding             ...(id,'onboarding')                           -> 'onboarding'
--   admin approval                       materialize_admin_pair                         -> its own source
--   queue promotion                      promote_queued_rows: flips an EXISTING row queued->suggested
--                                        and creates no pair, so it can never qualify a release
--   legacy / user-requested              createIntroRequest: status 'pending', not a visible card
--
-- generate-recommendations.ts:1179 maps the generation source to the pair source
-- (`source === 'weekly' ? 'weekly' : 'onboarding'`), so COVERAGE IS PART OF THE WEEKLY RELEASE and
-- is included deliberately - both weekly-refresh call sites pass 'weekly'. Onboarding and retry are
-- excluded, which is correct: a member completing onboarding on a Tuesday is not a weekly release.
--
-- ── EVIDENCE MUST NOT DEPEND ON A MUTABLE STATUS ──────────────────────────────────────────────
-- A member can act on a card seconds after receiving it and before finalization runs. Scoping
-- evidence on intro_requests.status = 'suggested' would let that erase proof the release happened.
-- Both predicates therefore rest on IMMUTABLE materialisation facts instead:
--   admin  - batch_suggestions.materialized_at, stamped once when the pair lands (064:603);
--   weekly - member_pairs.last_recommended_at plus the existence of both directional rows.
-- Neither changes when a member responds.
--
-- ── WHAT COMPLETED MEANS ──────────────────────────────────────────────────────────────────────
--   completed  := the writer's bounded loop reached its normal end
--              AND zero transient/system errors occurred
--              AND at least one member-visible introduction is committed for this window.
-- Deterministic refusals - capacity, cooldown, blocked, ineligible, invalid, duplicate,
-- exists_active, no candidate - are NORMAL outcomes of a curated network and do not prevent it.
-- There is exactly one completion value: a release either completed or was never recorded.
--
-- ── PRIVACY AND PRIVILEGE ─────────────────────────────────────────────────────────────────────
-- The row holds a week key, counts and timestamps. No member id, pair, card or batch contents.
-- RLS on with zero policies; browser roles hold nothing. A member may learn only "a release
-- happened this week" through a read-only SECURITY DEFINER function. Migrations 048, 058-060 and
-- 063-073 are untouched.
-- ==============================================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.weekly_batch_releases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The Thursday window this release belongs to, e.g. 'thu-2026-08-20'. DERIVED IN SQL by the
  -- finalization function - never accepted from a caller, so no historical key can be fabricated.
  release_key    text NOT NULL,
  source         text NOT NULL CHECK (source IN ('admin_approval', 'weekly_cron')),
  -- Provenance only, NULLABLE, and deliberately NOT a foreign key: the weekly reciprocal path has
  -- no batch row, and delete-batch hard-deletes drafts.
  batch_id       uuid NULL,
  -- Verified by the function from committed rows. A release with no visible card is unrepresentable.
  cards_released integer NOT NULL CHECK (cards_released > 0),
  members_reached integer NOT NULL DEFAULT 0 CHECK (members_reached >= 0),
  released_at    timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.weekly_batch_releases IS
  'Immutable proof that a weekly introduction batch completed. Written ONLY by public.finalize_weekly_release, which a writer calls after its loop reaches its normal end with zero transient errors. Visible cards alone are never sufficient: a crashed loop and a failed insert are indistinguishable afterwards. One row per Thursday window (UNIQUE release_key); a retry returns the existing fact and never overwrites it. Holds no member, pair, card or batch content.';

CREATE UNIQUE INDEX IF NOT EXISTS weekly_batch_releases_key_uniq
  ON public.weekly_batch_releases (release_key);
-- ONE release per admin batch, for all time. This is what stops a batch released in week 1 from
-- ever creating or satisfying a second fact after the calendar advances.
CREATE UNIQUE INDEX IF NOT EXISTS weekly_batch_releases_batch_uniq
  ON public.weekly_batch_releases (batch_id)
  WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS weekly_batch_releases_released_at_idx
  ON public.weekly_batch_releases (released_at DESC);

ALTER TABLE public.weekly_batch_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.weekly_batch_releases FROM PUBLIC;
REVOKE ALL ON TABLE public.weekly_batch_releases FROM anon, authenticated;

-- ── SERVICE_ROLE: EXPLICIT REVOKE BEFORE GRANT ────────────────────────────────────────────────
-- The GRANT below is additive and CANNOT remove a privilege it does not name. Supabase's
-- ALTER DEFAULT PRIVILEGES hands service_role broad table access at CREATE TABLE time, so this
-- table was born with UPDATE and DELETE, and naming only SELECT and INSERT left them in place.
-- Production confirmed exactly that after 074 was applied.
--
-- This is the same defect that required migrations 071 (introduction_email_outbox) and 073
-- (credit_transactions). The shape that actually works is always REVOKE first, then grant back.
--
-- It matters here specifically because a release fact is IMMUTABLE: the countdown is driven by it,
-- so a role able to rewrite or delete one could silently change what members are told about the
-- week. Removing the privileges makes that impossible rather than merely unintended.
--
-- Idempotent: REVOKE of an absent privilege and GRANT of a held one are both no-ops, so re-running
-- 074 changes nothing.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
ON TABLE public.weekly_batch_releases
FROM service_role;

-- SELECT + INSERT only. A release fact is immutable: no UPDATE, no DELETE, no TRUNCATE for anyone.
GRANT SELECT, INSERT
ON TABLE public.weekly_batch_releases
TO service_role;

-- ── THE FINALIZATION RPC ──────────────────────────────────────────────────────────────────────
-- Called by a writer ONLY after its loop reaches its normal end with zero transient errors.
-- Everything it records it derives or verifies itself, so a caller cannot fabricate a week, a
-- count, or a release that did not happen. In one transaction it:
--   1. derives the current Thursday window and its key from now();
--   2. takes an advisory lock on that key, so two writers cannot race;
--   3. returns the EXISTING fact if one is present (idempotent replay after a lost response);
--   4. verifies at least one member-visible introduction is committed for the window;
--   5. inserts the immutable fact and returns it.
-- If step 4 finds nothing it RAISES, so a caller can never mistake "nothing was released" for
-- success.
CREATE OR REPLACE FUNCTION public.finalize_weekly_release(
  p_source   text,
  p_batch_id uuid DEFAULT NULL
)
RETURNS TABLE (release_key text, released_at timestamptz, cards_released integer, was_existing boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_now          timestamptz := pg_catalog.now();
  v_window_start timestamptz;
  v_key          text;
  v_cards        integer;
  v_members      integer;
  v_prior        integer;
  v_existing     public.weekly_batch_releases%ROWTYPE;
BEGIN
  -- (7) Exactly two sources, and each has its own batch_id contract.
  IF p_source IS NULL OR p_source NOT IN ('admin_approval', 'weekly_cron') THEN
    RAISE EXCEPTION 'invalid_source' USING ERRCODE = 'P0001';
  END IF;
  -- (5) An admin finalization must name the batch it completed...
  IF p_source = 'admin_approval' AND p_batch_id IS NULL THEN
    RAISE EXCEPTION 'admin_requires_batch_id' USING ERRCODE = 'P0001';
  END IF;
  -- (6) ...and a weekly run has no batch, so passing one is a caller error, not a shortcut.
  IF p_source = 'weekly_cron' AND p_batch_id IS NOT NULL THEN
    RAISE EXCEPTION 'weekly_forbids_batch_id' USING ERRCODE = 'P0001';
  END IF;

  -- (2) IDENTITY BEFORE CALENDAR. An already-finalized batch returns ITS OWN fact, whatever week it
  -- is now. This is the boundary case: replaying approval of a week-1 batch in week 2 must return
  -- week 1's release, never manufacture week 2's.
  IF p_batch_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.weekly_batch_releases r WHERE r.batch_id = p_batch_id;
    IF FOUND THEN
      RETURN QUERY SELECT v_existing.release_key, v_existing.released_at, v_existing.cards_released, true;
      RETURN;
    END IF;

    -- (9) The batch must exist. An unrelated or invented uuid cannot buy a release.
    PERFORM 1 FROM public.introduction_batches ib WHERE ib.id = p_batch_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- The window is DERIVED, never supplied: the most recent Thursday 14:00 UTC at or before now().
  -- Epoch arithmetic, because 1970-01-01T00:00:00Z was itself a Thursday, so every window sits at
  -- 50400 + 604800n seconds. No local time is involved, so EST/EDT, leap days and year boundaries
  -- need no special case and cannot shift it.
  v_window_start := pg_catalog.to_timestamp(
    pg_catalog.floor((pg_catalog.date_part('epoch', v_now) - 50400) / 604800) * 604800 + 50400
  );
  v_key := 'thu-' || pg_catalog.to_char(v_window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD');

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_key, 0));

  -- (10) This week is already finalized by someone. Return the fact that stands.
  SELECT * INTO v_existing FROM public.weekly_batch_releases r WHERE r.release_key = v_key;
  IF FOUND THEN
    RETURN QUERY SELECT v_existing.release_key, v_existing.released_at, v_existing.cards_released, true;
    RETURN;
  END IF;

  -- (8) EVIDENCE SCOPED TO THIS WRITER AND THIS WINDOW — never "some card exists somewhere".
  IF p_source = 'admin_approval' THEN
    -- batch_suggestions.materialized_at is stamped by materialize_admin_pair at the instant a pair
    -- lands (064:603) and is never rewritten, so it proves THIS review batch made cards visible
    -- INSIDE the current window. Deliberately NOT joined to intro_requests.status: a member who
    -- responds immediately must not erase the proof that the release happened.
    SELECT count(*), count(DISTINCT bs.recipient_id)
      INTO v_cards, v_members
    FROM public.batch_suggestions bs
    WHERE bs.batch_id = p_batch_id
      AND bs.materialized_at IS NOT NULL
      AND bs.materialized_at >= v_window_start;

    -- (3) A batch whose work all happened in an EARLIER window must not be quietly re-dated into
    -- this one. Say so explicitly rather than returning a generic emptiness.
    IF COALESCE(v_cards, 0) <= 0 THEN
      SELECT count(*) INTO v_prior FROM public.batch_suggestions bs
      WHERE bs.batch_id = p_batch_id AND bs.materialized_at IS NOT NULL
        AND bs.materialized_at < v_window_start;
      IF COALESCE(v_prior, 0) > 0 THEN
        RAISE EXCEPTION 'batch_belongs_to_earlier_window' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  ELSE
    -- Scoped to the WEEKLY writer specifically, not to "any non-admin card":
    --   mp.source = 'weekly'          only weekly-refresh (broad + coverage) writes this value;
    --                                 onboarding, onboarding_retry, admin and migration cannot.
    --   last_recommended_at >= window the weekly run recommended this pair in THIS window; set by
    --                                 create_reciprocal_suggestion (063) and immutable thereafter.
    --   exactly two directional rows  a healthy reciprocal pair. An asymmetric or malformed pair
    --                                 cannot prove a release.
    -- No reference to intro_requests.status, so a member acting immediately changes nothing.
    SELECT count(*), count(DISTINCT ir.requester_id)
      INTO v_cards, v_members
    FROM public.member_pairs mp
    JOIN public.intro_requests ir
      ON ir.pair_id = mp.id
     AND ir.created_at >= v_window_start
    WHERE mp.source = 'weekly'
      AND mp.last_recommended_at IS NOT NULL
      AND mp.last_recommended_at >= v_window_start
      AND (SELECT count(*) FROM public.intro_requests x
           WHERE x.pair_id = mp.id AND x.created_at >= v_window_start) = 2;
  END IF;

  IF COALESCE(v_cards, 0) <= 0 THEN
    RAISE EXCEPTION 'no_visible_introductions' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.weekly_batch_releases (release_key, source, batch_id, cards_released, members_reached)
  VALUES (v_key, p_source, p_batch_id, v_cards, COALESCE(v_members, 0));

  RETURN QUERY
    SELECT r.release_key, r.released_at, r.cards_released, false
    FROM public.weekly_batch_releases r WHERE r.release_key = v_key;
END;
$fn$;

REVOKE ALL ON FUNCTION public.finalize_weekly_release(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_weekly_release(text, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_weekly_release(text, uuid) TO service_role;

COMMENT ON FUNCTION public.finalize_weekly_release(text, uuid) IS
  'THE only writer of weekly_batch_releases. Looks up an existing fact BY batch_id before touching the calendar, so replaying an already-finalized admin batch after the Thursday boundary returns its ORIGINAL release rather than manufacturing a new week. Derives the window from now(); scopes evidence to the exact run (admin: batch_suggestions.materialized_at within the window for THIS review batch; weekly: is_admin_initiated = false cards created within the window); and inserts the immutable fact - all in one transaction under an advisory lock. RAISES invalid_source, admin_requires_batch_id, weekly_forbids_batch_id, batch_not_found, batch_belongs_to_earlier_window or no_visible_introductions rather than letting a caller report a release that did not happen. A caller supplies no key, no window and no count.';

-- ── The only thing a browser role may learn ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.weekly_batch_released(p_release_key text)
RETURNS TABLE (release_key text, released_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT r.release_key, r.released_at
  FROM public.weekly_batch_releases r
  WHERE r.release_key = p_release_key
  LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION public.weekly_batch_released(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.weekly_batch_released(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.weekly_batch_released(text) TO authenticated, service_role;

COMMENT ON FUNCTION public.weekly_batch_released(text) IS
  'Returns the release key and timestamp for one Thursday window, or no row. The ONLY weekly_batch_releases data a browser role may see: no counts, no source, no batch id, no member information.';

COMMIT;
