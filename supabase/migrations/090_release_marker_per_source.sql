-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 090 — AN ADMIN SEND AND A CRON RUN ARE TWO FACTS, NOT ONE
--
-- WHY. weekly_batch_releases was UNIQUE on (release_key) alone, written by two independent
-- producers: the Thursday cron (source='weekly_cron') and Daniel pressing Send
-- (source='admin_approval'). Whichever ran first took the week's only slot, and
-- finalize_weekly_release returns the existing row rather than overwriting it — deliberately, the
-- table is append-only and UPDATE/DELETE are revoked from service_role.
--
-- That was harmless while any row satisfied the countdown. It stopped being harmless when
-- getCurrentCycleRelease began filtering source='admin_approval' (commit 26e5202), so that a cron
-- run could no longer claim a release nobody approved. The two changes together produce a state
-- with no exit:
--
--   thu-2026-08-27: the cron wrote its row Thursday 14:32 UTC and took the key.
--   Friday 00:37 UTC: the admin batch was approved and placed 47 cards.
--   finalize_weekly_release found the key taken, returned wasExisting=true, and wrote nothing.
--   The countdown, now requiring admin_approval, showed "being prepared" to every member —
--   for a batch that had actually shipped.
--
-- WHAT THIS DOES NOT DO. It does not let an admin send OVERWRITE the cron's row. Superseding would
-- mean either mutating a row the table declares immutable, or deleting a fact that is true — the
-- cron did run. Both facts are recorded instead, and the reader picks the one it means. The unique
-- key becomes (release_key, source): still at most one admin release and one cron release per
-- window, never two of a kind.
--
-- Idempotent and transactional. No row is inserted, updated or deleted by this migration.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── SECTION 1 — PRECONDITIONS ────────────────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname='public' AND c.relname='weekly_batch_releases' AND c.relkind='r') THEN
    RAISE EXCEPTION '090 REFUSED: public.weekly_batch_releases is missing. Apply 074 first.';
  END IF;
  IF to_regprocedure('public.finalize_weekly_release(text,uuid)') IS NULL THEN
    RAISE EXCEPTION '090 REFUSED: public.finalize_weekly_release(text,uuid) is missing. Apply 074 first.';
  END IF;
  -- Two rows of the SAME source in one window would violate the new key. Refuse rather than
  -- silently fail at index creation.
  IF EXISTS (SELECT 1 FROM public.weekly_batch_releases
             GROUP BY release_key, source HAVING count(*) > 1) THEN
    RAISE EXCEPTION '090 REFUSED: duplicate (release_key, source) rows exist; resolve them first.';
  END IF;
END
$pre$;

-- ── SECTION 2 — THE KEY ──────────────────────────────────────────────────────────────────────
-- One release per window PER PRODUCER, instead of one per window across both.
DROP INDEX IF EXISTS public.weekly_batch_releases_key_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS weekly_batch_releases_key_source_uniq
  ON public.weekly_batch_releases (release_key, source);

-- weekly_batch_releases_batch_uniq (batch_id) is deliberately UNCHANGED: one release per admin
-- batch for all time is still correct, and is what stops a week-1 batch satisfying week 2.

COMMENT ON TABLE public.weekly_batch_releases IS
  'Immutable proof that a weekly introduction batch completed. Written ONLY by public.finalize_weekly_release, which a writer calls after its loop reaches its normal end with zero transient errors. Visible cards alone are never sufficient: a crashed loop and a failed insert are indistinguishable afterwards. One row per Thursday window PER SOURCE (UNIQUE release_key, source) - the weekly cron and an admin send are independent facts and both are recorded; a retry of the SAME source returns the existing fact and never overwrites it. Holds no member, pair, card or batch content.';

-- ── SECTION 3 — THE FUNCTION, SOURCE-SCOPED ──────────────────────────────────────────────────
-- Exactly two predicates change: the "already finalized" probe and the final RETURN QUERY are
-- now scoped to (release_key, source) instead of release_key alone. Everything else - the derived
-- window, the advisory lock, the evidence checks, the batch-identity short circuit - is verbatim
-- from 074.
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
  SELECT * INTO v_existing FROM public.weekly_batch_releases r
   WHERE r.release_key = v_key AND r.source = p_source;
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
    FROM public.weekly_batch_releases r
    WHERE r.release_key = v_key AND r.source = p_source;
END;
$fn$;
-- ── SECTION 4 — POSTCONDITIONS ───────────────────────────────────────────────────────────────
DO $post$
DECLARE v_n int;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_indexes
             WHERE schemaname='public' AND indexname='weekly_batch_releases_key_uniq') THEN
    RAISE EXCEPTION '090 FAILED: the old release_key-only unique index still exists.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes
                 WHERE schemaname='public' AND indexname='weekly_batch_releases_key_source_uniq') THEN
    RAISE EXCEPTION '090 FAILED: weekly_batch_releases_key_source_uniq was not created.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes
                 WHERE schemaname='public' AND indexname='weekly_batch_releases_batch_uniq') THEN
    RAISE EXCEPTION '090 FAILED: the per-batch unique index was lost.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='finalize_weekly_release'
     AND pg_catalog.pg_get_functiondef(p.oid) LIKE '%AND r.source = p_source%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '090 FAILED: finalize_weekly_release is not source-scoped.';
  END IF;
  -- Still append-only for service_role: no UPDATE, no DELETE.
  IF pg_catalog.has_table_privilege('service_role','public.weekly_batch_releases','UPDATE')
     OR pg_catalog.has_table_privilege('service_role','public.weekly_batch_releases','DELETE') THEN
    RAISE EXCEPTION '090 FAILED: the release table is no longer append-only.';
  END IF;
  RAISE NOTICE '090 APPLIED: (release_key, source) is unique; finalize_weekly_release is source-scoped; table remains append-only.';
END
$post$;

COMMIT;
