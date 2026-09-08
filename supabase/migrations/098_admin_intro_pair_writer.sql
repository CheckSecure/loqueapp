-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 098 — public.create_admin_intro_pair: the authoritative writer for admin-proposed introductions
--
-- ─── THE GAP THIS CLOSES ──────────────────────────────────────────────────────────────────────
-- Migration 096 gated six relationship writers and added two new match primitives, on the premise
-- that a TypeScript pre-check followed by a service-role write is NOT a security boundary, because
-- service_role bypasses RLS. lib/introRequests/createAdminIntroPair.ts was the one discovery-
-- conferring path left outside that rule: it INSERTs two intro_requests rows DIRECTLY, as
-- service_role, with status 'admin_pending'.
--
-- 'admin_pending' is inside can_discover_profile's grant set (migration 079, line 72). It is not a
-- proposal that becomes visible later — the row itself makes the two members mutually discoverable
-- the moment it commits, before any match, credit or consent. So this is the EARLIEST discovery-
-- conferring write on that path, and it had no gate at all in the database.
--
-- It was widely assumed to be covered by public.materialize_admin_pair. It is not, and a fresh
-- trace confirms they are different flows with different semantics:
--
--   materialize_admin_pair (085)          create_admin_intro_pair (this file)
--   ── batch REVIEW approval              ── admin tool / Concierge, no batch at all
--   requires two symmetric                requires NO batch_suggestions row; there is no
--     batch_suggestions rows and            review batch id to pass
--     marks them 'shown'/materialized
--   writes status from a TIER decision    writes status 'admin_pending', always
--     ('suggested' / 'queued')
--   creates member_pairs + stamps         writes pair_id NULL — these rows are NOT pair-governed
--     pair_id on BOTH rows
--   creates/reuses recommendation_        writes batch_id NULL
--     batches envelopes per member
--   enforces visible/reserved capacity    enforces NO capacity — an admin proposal is not a
--     and response eligibility              recommendation card and never occupied a tier
--   'suggested' fires the 070 outbox      'admin_pending' fires NOTHING; the trigger keys on
--     email trigger                         status = 'suggested'
--
-- Routing through it would therefore change status, tier, pair_id, batch_id, capacity behaviour and
-- email behaviour all at once. This function does the ONE thing the admin path actually does, and
-- gates it.
--
-- ─── WHAT IT DOES NOT TAKE OVER ───────────────────────────────────────────────────────────────
-- The account-status, same-company, block, existing-match and duplicate-proposal gates stay in
-- TypeScript, where they are today and where their inputs live (isSameCompany's normalisation, the
-- signal-derived match_reason). They are PRODUCT gates. This migration moves exactly the checks
-- that must be authoritative at write time — community, participant existence, and pair identity —
-- and nothing else, so no existing refusal changes shape.
--
-- The duplicate-proposal check is the one exception, and it is re-implemented here IN ADDITION to
-- the TypeScript one rather than instead of it: under the pair advisory locks it is also the race
-- backstop that two concurrent admins clicking Introduce previously had none of.
--
-- match_reason is a PARAMETER. It is computed by lib/match-signals from a dozen profile columns and
-- cannot move into SQL; it is content, not a security property, so passing it in costs nothing.
--
-- Does NOT modify 095, 096 or 097. Does NOT touch community_pair_allowed. Creates no data.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── SECTION 0 — PRECONDITIONS ────────────────────────────────────────────────────────────────
DO $precheck$
DECLARE
  v_missing text;
BEGIN
  IF pg_catalog.to_regprocedure('public.community_pair_allowed(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION '098 REFUSED: public.community_pair_allowed(uuid, uuid) is absent (apply 095, then 096).';
  END IF;

  -- EVERY COLUMN THIS FUNCTION WRITES MUST EXIST, PROVEN BEFORE THE FUNCTION IS CREATED.
  --
  -- This is not boilerplate. intro_requests.admin_notes is written by the current TypeScript
  -- INSERT but has NO migration in this repository — it is one of the several columns this schema
  -- acquired outside the tracked workflow (see docs/migrations/*_as_built.md). Reproducing the
  -- INSERT faithfully means writing that column, and a CREATE FUNCTION whose body names a column
  -- that does not exist compiles happily in plpgsql and fails at CALL time, in production, on the
  -- first admin introduction. Failing here instead makes an unapplied assumption impossible to ship.
  SELECT pg_catalog.string_agg(c.name, ', ' ORDER BY c.name) INTO v_missing
  FROM (VALUES
    ('requester_id'), ('target_user_id'), ('status'), ('is_admin_initiated'),
    ('match_reason'), ('admin_notes'), ('created_at'), ('pair_id'), ('batch_id')
  ) AS c(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.intro_requests'::pg_catalog.regclass
      AND a.attname = c.name AND a.attnum > 0 AND NOT a.attisdropped
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '098 REFUSED: public.intro_requests is missing column(s): %.', v_missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.profiles'::pg_catalog.regclass
      AND a.attname = 'member_type' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION '098 REFUSED: profiles.member_type is absent — apply migration 095 first.';
  END IF;
END
$precheck$;


-- ── SECTION 1 — THE WRITER ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_admin_intro_pair(
  p_user_a      uuid,
  p_user_b      uuid,
  p_match_reason text DEFAULT NULL,   -- the signal-enriched reason, computed by the caller
  p_admin_notes  text DEFAULT 'manual_create'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  lo uuid;
  hi uuid;
  v_present  integer;
  v_now      timestamptz := pg_catalog.now();
  v_rows     jsonb;
BEGIN
  ---------------------------------------------------------------- (1) shape
  -- Mirrors the caller's own first guard exactly, so the refusal is identical whichever layer
  -- notices first: `!userAId || !userBId || userAId === userBId` -> 'invalid_pair'.
  IF p_user_a IS NULL OR p_user_b IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','missing_argument');
  END IF;
  IF p_user_a = p_user_b THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','self_pair');
  END IF;

  ---------------------------------------------------------------- (2) canonical locks
  -- Same key space and canonical LEAST/GREATEST order as create_reciprocal_suggestion,
  -- materialize_admin_pair, place_batch_rows, promote_queued_rows, finalize_mutual_match_atomic
  -- and create_gated_match. Two concurrent admin introductions sharing a member therefore
  -- serialise against each other AND against every other writer, and introduce no new deadlock
  -- class. Everything read below happens with both locks held.
  lo := LEAST(p_user_a, p_user_b);
  hi := GREATEST(p_user_a, p_user_b);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lo::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text, 0));

  ---------------------------------------------------------------- (3) both participants exist
  -- FOR SHARE pins each row — and therefore member_type — for the rest of the transaction, so the
  -- community answer below cannot go stale between the check and the INSERT. Reported separately
  -- from 'cross_community' because community_pair_allowed returns false for BOTH a missing member
  -- and a mismatched one, and an operator needs to know which.
  SELECT count(*) INTO v_present
  FROM (
    SELECT p.id FROM public.profiles p WHERE p.id IN (lo, hi) ORDER BY p.id FOR SHARE
  ) s;
  IF v_present < 2 THEN
    RETURN pg_catalog.jsonb_build_object('outcome','ineligible','detail','profile_missing');
  END IF;

  ---------------------------------------------------------------- (4) THE BOUNDARY
  -- Under both advisory locks, with both profile rows share-locked, in the same transaction as the
  -- INSERT below. This is the authoritative check: a TypeScript pre-check runs in another process
  -- against a snapshot, and service_role bypasses RLS, so nothing outside this function body can
  -- bind the write.
  IF NOT public.community_pair_allowed(lo, hi) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','ineligible','detail','cross_community');
  END IF;

  ---------------------------------------------------------------- (5) duplicate proposal
  -- Byte-for-byte the caller's existing predicate: an admin-initiated row in EITHER direction whose
  -- status is 'admin_pending' or 'approved'. The caller still runs this first (unchanged); this
  -- copy exists because the caller's version is a read outside any lock, so two admins introducing
  -- the same pair simultaneously could both pass it and both insert. Here it is inside the locks.
  IF EXISTS (
    SELECT 1 FROM public.intro_requests ir
    WHERE ((ir.requester_id = lo AND ir.target_user_id = hi)
        OR (ir.requester_id = hi AND ir.target_user_id = lo))
      AND ir.is_admin_initiated = true
      AND ir.status IN ('admin_pending', 'approved')
  ) THEN
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'id', ir.id, 'requester_id', ir.requester_id, 'target_user_id', ir.target_user_id,
             'status', ir.status, 'is_admin_initiated', ir.is_admin_initiated)
             ORDER BY ir.id)
      INTO v_rows
    FROM public.intro_requests ir
    WHERE ((ir.requester_id = lo AND ir.target_user_id = hi)
        OR (ir.requester_id = hi AND ir.target_user_id = lo))
      AND ir.is_admin_initiated = true
      AND ir.status IN ('admin_pending', 'approved');

    RETURN pg_catalog.jsonb_build_object('outcome','already_proposed','rows', COALESCE(v_rows, '[]'::jsonb));
  END IF;

  ---------------------------------------------------------------- (6) ════ THE ONLY WRITE ════
  -- Everything above is read-only, so every refusal returns with the database untouched and no
  -- half-created reciprocal pair is possible. Both directions are inserted by ONE statement, in one
  -- transaction: it is not possible for one member to hold a proposal the other does not.
  --
  -- REPRODUCED EXACTLY FROM THE TYPESCRIPT INSERT IT REPLACES:
  --   status              'admin_pending'   (never a tier status; occupies no capacity)
  --   is_admin_initiated  true              (renders "Introduced by Andrel" on both sides)
  --   match_reason        the SAME string on both rows — it is shown to both members
  --   admin_notes         'manual_create' (admin tool) or 'concierge' (Concierge flow)
  --   created_at          one timestamp shared by both rows
  --   pair_id             NOT WRITTEN -> NULL. These rows are deliberately not pair-governed;
  --                       pair_id is what makes a row reciprocal, and only the pair RPCs set it.
  --   batch_id            NOT WRITTEN -> NULL. There is no recommendation envelope here.
  --   updated_at          NOT WRITTEN, so the column default applies exactly as it did before.
  --                       Naming it with now() would look harmless and would silently change the
  --                       stored value on any schema whose default is not now().
  -- The 070 outbox trigger fires on this INSERT and writes NOTHING, because it keys on
  -- status = 'suggested'. That is the existing behaviour and it is preserved by construction.
  WITH ins AS (
    INSERT INTO public.intro_requests
      (requester_id, target_user_id, status, is_admin_initiated, match_reason, admin_notes, created_at)
    VALUES
      (p_user_a, p_user_b, 'admin_pending', true, p_match_reason, p_admin_notes, v_now),
      (p_user_b, p_user_a, 'admin_pending', true, p_match_reason, p_admin_notes, v_now)
    RETURNING id, requester_id, target_user_id, status, is_admin_initiated
  )
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', ins.id, 'requester_id', ins.requester_id, 'target_user_id', ins.target_user_id,
           'status', ins.status, 'is_admin_initiated', ins.is_admin_initiated))
    INTO v_rows
  FROM ins;

  -- Defensive, and cheap: two rows or nothing. A jsonb_agg that came back with anything else means
  -- the INSERT did not do what this function claims, and the caller must not be told it succeeded.
  IF v_rows IS NULL OR pg_catalog.jsonb_array_length(v_rows) <> 2 THEN
    RAISE EXCEPTION 'create_admin_intro_pair: expected 2 rows, produced %',
      COALESCE(pg_catalog.jsonb_array_length(v_rows), 0);
  END IF;

  RETURN pg_catalog.jsonb_build_object('outcome','created','rows', v_rows);
END
$$;

-- ── SECTION 2 — PRIVILEGES ───────────────────────────────────────────────────────────────────
-- The browser can never call this. The only caller is lib/introRequests/createAdminIntroPair.ts,
-- reached from two admin-authorized routes, both of which run server-side as service_role — so
-- service_role is the minimum (and only) grant required.
REVOKE ALL ON FUNCTION public.create_admin_intro_pair(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_admin_intro_pair(uuid, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.create_admin_intro_pair(uuid, uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_admin_intro_pair(uuid, uuid, text, text) TO service_role;

COMMENT ON FUNCTION public.create_admin_intro_pair(uuid, uuid, text, text) IS
  'The authoritative writer for ADMIN-PROPOSED introductions: two symmetric admin_pending '
  'intro_requests rows, community-gated under canonical pair advisory locks, in one transaction. '
  'admin_pending is discovery-conferring (migration 079), which is why this write cannot be left to '
  'a TypeScript pre-check while service_role bypasses RLS. Deliberately NOT materialize_admin_pair: '
  'that RPC is the batch-review path and writes a tier status, pair_id, batch envelopes and '
  'capacity. Writes pair_id NULL and batch_id NULL. Charges nothing, notifies nothing. '
  'service_role EXECUTE only. Migration 098.';


-- ── SECTION 3 — POSTAPPLY PROOF ──────────────────────────────────────────────────────────────
DO $postcheck$
DECLARE
  v_src text;
  v_code text;
  v_secdef boolean;
  v_cfg text;
  v_ret text;
  c_sig constant text := 'public.create_admin_intro_pair(uuid, uuid, text, text)';
BEGIN
  IF pg_catalog.to_regprocedure(c_sig) IS NULL THEN
    RAISE EXCEPTION '098: % was not created.', c_sig;
  END IF;

  SELECT p.prosrc, p.prosecdef,
         COALESCE(pg_catalog.array_to_string(p.proconfig, ','), '(none)'),
         pg_catalog.format_type(p.prorettype, NULL)
    INTO v_src, v_secdef, v_cfg, v_ret
  FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure(c_sig);

  IF NOT v_secdef THEN
    RAISE EXCEPTION '098: create_admin_intro_pair is not SECURITY DEFINER.';
  END IF;
  IF v_cfg NOT IN ('search_path=', 'search_path=""') THEN
    RAISE EXCEPTION '098: create_admin_intro_pair has a mutable search_path (%).', v_cfg;
  END IF;
  IF v_ret <> 'jsonb' THEN
    RAISE EXCEPTION '098: create_admin_intro_pair returns %, expected jsonb.', v_ret;
  END IF;

  -- CONTENT ASSERTIONS RUN AGAINST THE EXECUTABLE BODY, NOT THE COMMENTS.
  --
  -- pg_proc.prosrc includes this function's own comments, and those comments necessarily discuss
  -- the tier statuses in order to say the function must never write one ("never a tier status";
  -- "the 070 trigger keys on status = 'suggested'"). A naive scan of prosrc therefore fails on the
  -- documentation that states the rule — which is exactly what happened the first time this
  -- migration was run against the local harness. Stripping '--' lines makes every check below a
  -- statement about CODE, which is what each of them was always meant to be, and makes the positive
  -- assertions stronger too: they now prove the guard is executed, not merely mentioned.
  SELECT pg_catalog.string_agg(l, E'\n')
    INTO v_code
  FROM pg_catalog.regexp_split_to_table(v_src, E'\n') AS t(l)
  WHERE pg_catalog.btrim(l) NOT LIKE '--%';

  IF pg_catalog.strpos(v_code, 'community_pair_allowed') = 0 THEN
    RAISE EXCEPTION '098: create_admin_intro_pair does not EXECUTE the community guard.';
  END IF;
  IF pg_catalog.strpos(v_code, 'pg_advisory_xact_lock') = 0 THEN
    RAISE EXCEPTION '098: create_admin_intro_pair does not take the participant advisory locks.';
  END IF;
  IF pg_catalog.strpos(v_code, 'admin_pending') = 0 THEN
    RAISE EXCEPTION '098: create_admin_intro_pair no longer writes admin_pending.';
  END IF;
  -- It must never write a capacity-occupying status. This is what keeps it out of the tier model
  -- that place_batch_rows / promote_queued_rows / materialize_admin_pair own.
  IF pg_catalog.strpos(v_code, '''suggested''') > 0 OR pg_catalog.strpos(v_code, '''queued''') > 0 THEN
    RAISE EXCEPTION '098: create_admin_intro_pair writes a tier status; it must only write admin_pending.';
  END IF;
  -- pair_id and batch_id must stay out of the INSERT entirely: writing either would make these
  -- rows pair-governed or batch-governed, which is materialize_admin_pair's model, not this one.
  IF pg_catalog.strpos(v_code, 'pair_id') > 0 OR pg_catalog.strpos(v_code, 'batch_id') > 0 THEN
    RAISE EXCEPTION '098: create_admin_intro_pair references pair_id/batch_id; both must be left NULL.';
  END IF;

  -- ACLs.
  IF pg_catalog.has_function_privilege('anon', c_sig, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', c_sig, 'EXECUTE') THEN
    RAISE EXCEPTION '098: a browser role can EXECUTE create_admin_intro_pair.';
  END IF;
  IF NOT pg_catalog.has_function_privilege('service_role', c_sig, 'EXECUTE') THEN
    RAISE EXCEPTION '098: service_role cannot EXECUTE create_admin_intro_pair.';
  END IF;

  -- 095/096 contracts still intact — this migration must not have disturbed them.
  IF pg_catalog.has_function_privilege('anon', 'public.community_pair_allowed(uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'public.community_pair_allowed(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '098: community_pair_allowed became browser-executable.';
  END IF;
  IF pg_catalog.has_function_privilege('service_role',
       'public.consume_credits_and_create_match(uuid, uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '098: consume_credits_and_create_match is no longer sealed from service_role.';
  END IF;
  IF pg_catalog.has_table_privilege('anon', 'public.profiles', 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION '098: a browser role holds SELECT on public.profiles.';
  END IF;
END
$postcheck$;

COMMIT;
