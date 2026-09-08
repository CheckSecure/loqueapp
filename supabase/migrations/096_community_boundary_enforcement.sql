-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 096 — COMMUNITY BOUNDARY ENFORCEMENT (Andrel Next, Phase 3 Stage 1a)
--
-- Migration 095 DEFINED the Professional/Next boundary and enforced it nowhere:
-- community_pair_allowed() had zero callers, and the boundary held only because no member had
-- member_type = 'next'. This migration makes it real, at the layer where a relationship row is
-- actually written, inside the same transaction and under the same advisory locks as the write.
--
-- ─── WHAT "AUTHORITATIVE" MEANS HERE, AND WHY RLS IS NOT IT ───────────────────────────────────
-- Every relationship-creating path in this application runs as service_role, which BYPASSES RLS.
-- An RLS policy on matches or intro_requests would therefore be invisible to every writer the
-- product actually uses. The check has to be inside the function body, after the locks, before the
-- write — which is what each guard below is. A TypeScript pre-check followed by a service-role
-- insert is NOT equivalent and is not treated as such anywhere in this file.
--
-- ─── THE EARLIEST DISCOVERY-CONFERRING ROW ────────────────────────────────────────────────────
-- public.can_discover_profile (079) reads exactly four tables: profiles, blocked_users, matches and
-- intro_requests. It is NOT match creation that first exposes a member — it is an intro_requests row
-- whose status is in the discovery grant set. 'queued' is deliberately OUTSIDE that set; 'suggested'
-- is inside it. So the boundary sits one step earlier than "creating a match", and promote_queued_rows
-- (which performs exactly that status transition) is guarded here for that reason.
--
-- ─── HOW THE SIX EXISTING FUNCTIONS WERE RESTATED ─────────────────────────────────────────────
-- CREATE OR REPLACE FUNCTION has no "add a statement" form, so each body is reproduced in full.
-- None of it was transcribed by hand. Each body was extracted programmatically from its
-- authoritative migration by anchoring on the literal
--     CREATE OR REPLACE FUNCTION public.<name>(
-- taking the LAST such definition in that file, and verifying per-function identity markers. A
-- no-guard reconstruction of each was asserted byte-identical to its source before any guard was
-- spliced in. (An earlier extractor anchored on the first textual MENTION of a name and silently
-- produced create_reciprocal_suggestion's body labelled place_batch_rows — 085 mentions those names
-- in a precondition VALUES list at line 150, long before it defines them at 793/1053. That near-miss
-- is why the identity markers and the round-trip assertion exist.)
--
--   create_reciprocal_suggestion       093   158 body lines
--   place_batch_rows                   085   246 body lines
--   promote_queued_rows                085   138 body lines
--   materialize_admin_pair             085   425 body lines
--   finalize_mutual_match_atomic       067    82 body lines
--   consume_credits_and_create_match   087   162 body lines
--
-- Nothing else in those bodies was reformatted, reordered, renamed or simplified.
--
-- ─── PAIRWISE vs SET-WISE ─────────────────────────────────────────────────────────────────────
-- Four functions take a PAIR and get a single early-return guard. Two take one member and a SET of
-- counterparts (place_batch_rows takes p_rows; promote_queued_rows acts on the member's queued
-- rows) and get a FILTER in the same predicate chain as the existing blocked/matched/cooldown
-- exclusions. Filtering rather than rejecting is deliberate: refusing an entire placement because
-- one candidate is cross-community would cost a member their whole cycle for a condition Stage 2's
-- pool scoping will stop from arising. The security invariant is identical either way — a
-- cross-community counterpart can never produce a discovery-conferring row.
--
-- ─── WHAT THIS MIGRATION DOES NOT DO ──────────────────────────────────────────────────────────
-- community_pair_allowed is NOT modified — not one byte. No mentorship exception is added anywhere:
-- the Andrel Next bridge will be a separate authorized path, never a loosening of the default rule.
-- No candidate pool is scoped (Stage 2). No TypeScript caller is changed (Stage 1b). No grant on
-- public.profiles is touched. conversation_participants is not created. No production data is
-- written, and no Next member exists or is created.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── SECTION 0 — PRECONDITIONS ────────────────────────────────────────────────────────────────
DO $precheck$
DECLARE
  v_missing text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.profiles'::pg_catalog.regclass
      AND a.attname = 'member_type' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION '096 REFUSED: profiles.member_type is absent — apply migration 095 first.';
  END IF;

  IF pg_catalog.to_regprocedure('public.community_pair_allowed(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION '096 REFUSED: public.community_pair_allowed(uuid, uuid) is absent (migration 095).';
  END IF;

  -- Every function this migration REPLACES must already exist under the exact signature it is
  -- being replaced at. Replacing a function that is not there would silently CREATE a new one.
  SELECT pg_catalog.string_agg(x.sig, ', ') INTO v_missing
  FROM (VALUES
    ('public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer, uuid)'),
    ('public.place_batch_rows(uuid, text, jsonb, uuid, integer)'),
    ('public.promote_queued_rows(uuid)'),
    ('public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer)'),
    ('public.finalize_mutual_match_atomic(uuid, uuid, boolean)'),
    ('public.consume_credits_and_create_match(uuid, uuid, boolean)')
  ) AS x(sig)
  WHERE pg_catalog.to_regprocedure(x.sig) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '096 REFUSED: expected function(s) absent: %.', v_missing;
  END IF;
END
$precheck$;


-- ── SECTION 1 — THE SIX AUTHORITATIVE WRITERS, RESTATED WITH THEIR COMMUNITY GUARD ──────────

-- ---- create_reciprocal_suggestion  (body from migration 093, 158 original lines) ----
CREATE OR REPLACE FUNCTION public.create_reciprocal_suggestion(
  a_id uuid,
  b_id uuid,
  p_source text DEFAULT 'reciprocal',
  p_reason text DEFAULT NULL,          -- genuine fit reason (or NULL); NOT the label
  p_cooldown_days integer DEFAULT 30,
  p_max_cards integer DEFAULT 2,       -- >=1 is clamped to c_max_visible; NULL/<=0 -> 'invalid'
  p_release_id uuid DEFAULT NULL       -- the RELEASE ENVELOPE this placement belongs to (081)
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''            -- hardened: no mutable search_path; every ref is schema-qualified
AS $$
DECLARE
  c_max_visible constant integer := 2;   -- THE visible cap. Fixed here; no argument can raise it.
  lo uuid;
  hi uuid;
  pair public.member_pairs%ROWTYPE;
  eligible_count integer;
  a_cards integer;
  b_cards integer;
  max_cards integer;
  cutoff timestamptz := now() - make_interval(days => GREATEST(p_cooldown_days, 0));
BEGIN
  IF a_id IS NULL OR b_id IS NULL OR a_id = b_id THEN
    RETURN 'invalid';
  END IF;

  -- CAPACITY AUTHORITY IS THE DATABASE'S, AND A NONSENSE INPUT FAILS CLOSED.
  --
  --   >= 1        -> LEAST(value, c_max_visible). A caller may ask for FEWER cards than the cap (a
  --                  conservative producer); it can never ask for more, so p_max_cards = 100
  --                  behaves exactly as 2.
  --   NULL / <= 0 -> 'invalid', returned BEFORE any lock is taken and before any write.
  --
  -- The earlier draft coalesced NULL/0/negative up to the full cap of 2. That is the wrong
  -- direction: it turned a caller that had lost track of its own limit into a caller asking for the
  -- maximum. The TypeScript client no longer supplies this argument at all, so any NULL or
  -- non-positive value now reaching this function is a legacy or malformed call, and refusing it is
  -- both safe and informative. No legitimate caller passes one — verified repo-wide.
  IF p_max_cards IS NULL OR p_max_cards < 1 THEN
    RETURN 'invalid';
  END IF;
  max_cards := LEAST(p_max_cards, c_max_visible);

  lo := LEAST(a_id, b_id);
  hi := GREATEST(a_id, b_id);

  -- (0) PARTICIPANT-SAFE LOCKING. Transaction-scoped advisory lock on BOTH members, ALWAYS in
  --     canonical order (lo then hi) so concurrent calls sharing a member serialize and can never
  --     deadlock. Every count below happens only after both locks are held.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lo::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text, 0));

  -- (0b) COMMUNITY BOUNDARY (migration 096). Evaluated under BOTH advisory locks and in the same
  -- transaction as the insert below, so member_type cannot change between the check and the write.
  -- 'ineligible' is deliberate: walkCandidates already treats it as a DETERMINISTIC skip that is
  -- never retried, so no TypeScript caller changes for this guard.
  IF NOT public.community_pair_allowed(lo, hi) THEN
    RETURN 'ineligible';
  END IF;

  -- (1) Both members currently eligible (canonical eligibility flags — mirrors lib/matching/eligibility.ts).
  SELECT count(*) INTO eligible_count
  FROM public.profiles p
  WHERE p.id IN (lo, hi)
    AND p.account_status = 'active'
    AND p.profile_complete = true
    AND coalesce(p.is_test_account, false) = false
    AND coalesce(p.is_admin, false) = false
    AND coalesce(p.matching_paused, false) = false
    AND p.email <> 'bizdev91@gmail.com';
  IF eligible_count <> 2 THEN
    RETURN 'ineligible';
  END IF;

  -- (2) Not blocked in either direction.
  IF EXISTS (
    SELECT 1 FROM public.blocked_users bu
    WHERE (bu.user_id = lo AND bu.blocked_user_id = hi)
       OR (bu.user_id = hi AND bu.blocked_user_id = lo)
  ) THEN
    RETURN 'ineligible';
  END IF;

  -- (3) Not already connected (matches is column-ordered → check both orders).
  IF EXISTS (
    SELECT 1 FROM public.matches m
    WHERE (m.user_a_id = lo AND m.user_b_id = hi)
       OR (m.user_a_id = hi AND m.user_b_id = lo)
  ) THEN
    RETURN 'ineligible';
  END IF;

  -- (4) No live/committed intro between them in EITHER direction (active window + expressed interest
  --     + permanent history), and no RECENT soft dismissal (passed/expired within cooldown). This
  --     also prevents a re-recommendation from surfacing a DUPLICATE active card next to an old row.
  IF EXISTS (
    SELECT 1 FROM public.intro_requests ir
    WHERE ((ir.requester_id = lo AND ir.target_user_id = hi)
        OR (ir.requester_id = hi AND ir.target_user_id = lo))
      AND (
        ir.status IN ('suggested','queued','pending','accepted','accepted_pending_payment',
                      'admin_pending','approved','declined','rejected','hidden','hidden_permanent')
        OR (ir.status IN ('passed','expired') AND ir.updated_at >= cutoff)
      )
  ) THEN
    RETURN 'exists_active';
  END IF;

  -- (5) CAPACITY (both sides) — VISIBLE TIER ONLY. CHANGED FROM MIGRATION 050, which counted
  --     status IN ('suggested','queued') and so treated a reservation nobody has seen as if it were
  --     already on the member's screen. That was wrong in both directions: it refused an
  --     introduction to a member whose screen was empty but who held two queued rows, while never
  --     bounding how many 'suggested' rows could actually accumulate. A pair consumes one VISIBLE
  --     slot for EACH member. If either side is full → skip. Nothing is ever evicted.
  SELECT count(*) INTO a_cards FROM public.intro_requests ir
    WHERE ir.requester_id = a_id AND ir.status = 'suggested'
      AND ir.capacity_released_at IS NULL;
  SELECT count(*) INTO b_cards FROM public.intro_requests ir
    WHERE ir.requester_id = b_id AND ir.status = 'suggested'
      AND ir.capacity_released_at IS NULL;
  IF a_cards >= max_cards OR b_cards >= max_cards THEN
    RETURN 'capacity';
  END IF;

  -- (5b) RESPONSE ELIGIBILITY — REMOVED IN 093, replaced by the deficit already enforced above.
  --
  --      The removed statements counted a member's unanswered cards and refused outright when the
  --      count exceeded zero: a BINARY gate, where one unanswered card blocked a reciprocal
  --      placement entirely.
  --
  --      The admin batch never had that rule. app/api/admin/generate-batch computes
  --      visible_deficit = max(0, MAX_VISIBLE - visible_count) "and nothing else", so the two paths
  --      disagreed about who was eligible: a member holding one card was owed one more by the batch
  --      and zero by this function — precisely the coverage/batch split the rule meant to avoid.
  --
  --      CAPACITY IS UNCHANGED. Step (5) immediately above already returns 'capacity' when
  --      a_cards >= max_cards or b_cards >= max_cards. With max_cards = 2 a member holding one card
  --      passes and receives one more. Act on one, get one; act on both, get two. This deletes a
  --      SECOND, stricter rule that only this path applied — it does not raise anyone's ceiling.
  --
  --      p_release_id stays in the signature: it no longer feeds an eligibility count, but callers
  --      pass it and it is still stamped on a_id's row below as the release envelope.

  -- (6) Claim / lock the canonical pair row (serializes concurrent creation of the SAME pair).
  INSERT INTO public.member_pairs (user_a_id, user_b_id, source)
  VALUES (lo, hi, p_source)
  ON CONFLICT (user_a_id, user_b_id) DO NOTHING;

  SELECT * INTO pair FROM public.member_pairs mp
  WHERE mp.user_a_id = lo AND mp.user_b_id = hi
  FOR UPDATE;

  -- (7) Cooldown on re-recommendation of an existing pair.
  IF pair.last_recommended_at IS NOT NULL AND pair.last_recommended_at >= cutoff THEN
    RETURN 'cooldown';
  END IF;

  -- (8) Create BOTH standard suggestion cards atomically (this transaction). batch_id stays NULL:
  --     these are pair-governed, so a member's weekly batch refresh cannot drop one side while the
  --     other survives. The label comes from pair_id; match_reason carries only a genuine fit reason.
  --     release_id is stamped on a_id's row ONLY. It records which release this card belongs to so a
  --     sibling card of the same release is not treated as prior unanswered work. b_id's card is
  --     deliberately left NULL: it is an independent placement from b_id's point of view.
  INSERT INTO public.intro_requests
    (requester_id, target_user_id, status, is_admin_initiated, match_reason, pair_id, release_id, created_at, updated_at)
  VALUES
    (a_id, b_id, 'suggested', false, p_reason, pair.id, p_release_id, now(), now()),
    (b_id, a_id, 'suggested', false, p_reason, pair.id, NULL,         now(), now());

  UPDATE public.member_pairs
  SET recommend_count = recommend_count + 1,
      last_recommended_at = now(),
      first_recommended_at = coalesce(first_recommended_at, now()),
      status = 'active'
  WHERE id = pair.id;

  RETURN 'created';
END;
$$;

-- ---- place_batch_rows  (body from migration 085, 246 original lines) ----
CREATE OR REPLACE FUNCTION public.place_batch_rows(
  p_member_id uuid,
  p_source text,
  p_rows jsonb,
  p_reciprocal_batch_id uuid DEFAULT NULL,
  p_cooldown_days integer DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_max_visible  constant integer := 2;    -- THE visible cap  (status 'suggested')
  c_max_reserved constant integer := 2;    -- THE reserved cap (status 'queued')
  c_max_rows     constant integer := 50;   -- payload bound; a batch is 2 rows, 50 is generous
  c_uuid         constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_active    public.recommendation_batches%ROWTYPE;
  v_queued    public.recommendation_batches%ROWTYPE;
  v_n_active  integer;
  v_n_queued  integer;
  v_visible   integer;
  v_reserved  integer;
  v_visible_free  integer;
  v_reserved_free integer;
  v_supplied   integer;
  v_candidates jsonb;
  v_n_cand     integer;
  v_take_v     integer := 0;
  v_take_r     integer := 0;
  v_active_id  uuid := NULL;
  v_queued_id  uuid := NULL;
  v_cutoff     timestamptz := now() - make_interval(days => GREATEST(coalesce(p_cooldown_days, 30), 0));
  v_now        timestamptz := now();
BEGIN
  ------------------------------------------------------------------ validation (no writes)
  IF p_member_id IS NULL THEN
    RETURN jsonb_build_object('placed', false, 'reason', 'invalid');
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('onboarding','weekly','admin_reciprocal','migration') THEN
    RETURN jsonb_build_object('placed', false, 'reason', 'invalid');
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN jsonb_build_object('placed', false, 'reason', 'invalid');
  END IF;

  v_supplied := jsonb_array_length(p_rows);
  IF v_supplied = 0 THEN
    RETURN jsonb_build_object('placed', false, 'reason', 'empty');
  END IF;
  IF v_supplied > c_max_rows THEN
    -- Refuse outright rather than silently taking a prefix: an oversized payload means the caller is
    -- not the producer this function was designed for, and truncating would hide that.
    RETURN jsonb_build_object('placed', false, 'reason', 'too_many_rows', 'dropped', v_supplied);
  END IF;

  ------------------------------------------------------------------ (0) lock, THEN read anything
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_member_id::text, 0));

  ------------------------------------------------------------------ (1) the MEMBER must be eligible
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_member_id
      AND p.account_status = 'active'
      AND p.profile_complete = true
      AND coalesce(p.is_test_account, false) = false
      AND coalesce(p.is_admin, false) = false
      AND coalesce(p.matching_paused, false) = false
      AND p.email <> 'bizdev91@gmail.com'
  ) THEN
    RETURN jsonb_build_object('placed', false, 'reason', 'ineligible');
  END IF;

  ------------------------------------------------------------------ (2) candidates, computed ONCE
  -- Parsed → uuid-screened → non-self → de-duplicated (FIRST occurrence wins, so ranker order is
  -- preserved) → target eligible → not blocked → not matched → no live intro → not in cooldown.
  -- Materialised into a jsonb array so the set is evaluated exactly once and the inserts below
  -- cannot drift from the counts. A temp table is deliberately not used: it would not resolve under
  -- `search_path = ''` and would collide when two placements share a transaction.
  SELECT jsonb_agg(jsonb_build_object('t', f.target_user_id, 'r', f.match_reason) ORDER BY f.rank)
    INTO v_candidates
  FROM (
    WITH parsed AS (
      SELECT e.value ->> 'target_user_id' AS raw_target,
             nullif(e.value ->> 'match_reason', '') AS match_reason,
             e.ordinality AS rank
      FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e(value, ordinality)
    ),
    -- MATERIALIZED is load-bearing, not decoration. Postgres does not guarantee that a WHERE
    -- predicate runs before a cast in the same query level, so `WHERE raw_target ~* c_uuid` cannot
    -- protect `raw_target::uuid` from raising 22P02 on a malformed value. Materialising the screen
    -- forces the filter to complete first, which is what makes a hostile payload drop cleanly
    -- instead of aborting the transaction with a raw SQL error.
    screened AS MATERIALIZED (
      SELECT raw_target, match_reason, rank
      FROM parsed
      WHERE raw_target IS NOT NULL
        AND raw_target ~* c_uuid                       -- cast only what is syntactically a uuid
    ),
    valid AS (
      SELECT (raw_target)::uuid AS target_user_id, match_reason, rank
      FROM screened
      WHERE (raw_target)::uuid <> p_member_id          -- a self-pair is never a recommendation
    ),
    deduped AS (
      SELECT DISTINCT ON (target_user_id) target_user_id, match_reason, rank
      FROM valid ORDER BY target_user_id, rank
    )
    SELECT d.* FROM deduped d
    -- the target exists AND is eligible (this also guarantees the FK below can never fail)
    WHERE EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = d.target_user_id
        AND p.account_status = 'active'
        AND p.profile_complete = true
        AND coalesce(p.is_test_account, false) = false
        AND coalesce(p.is_admin, false) = false
        AND coalesce(p.matching_paused, false) = false
        AND p.email <> 'bizdev91@gmail.com'
    )
    -- COMMUNITY BOUNDARY (migration 096). A SET-WISE filter, in the same candidate chain as the
    -- blocked/matched/cooldown exclusions below, so a cross-community counterpart simply drops out
    -- of v_candidates and the member's remaining valid candidates in the SAME call proceed
    -- normally. Rejecting the whole placement because one candidate is cross-community would cost
    -- a member their entire cycle's introductions for a condition the Stage 2 pool scoping will
    -- prevent from arising at all.
    AND public.community_pair_allowed(p_member_id, d.target_user_id)
    -- not blocked in either direction
    AND NOT EXISTS (
      SELECT 1 FROM public.blocked_users bu
      WHERE (bu.user_id = p_member_id AND bu.blocked_user_id = d.target_user_id)
         OR (bu.user_id = d.target_user_id AND bu.blocked_user_id = p_member_id)
    )
    -- not already connected (matches is column-ordered → check both orders)
    AND NOT EXISTS (
      SELECT 1 FROM public.matches m
      WHERE (m.user_a_id = p_member_id AND m.user_b_id = d.target_user_id)
         OR (m.user_a_id = d.target_user_id AND m.user_b_id = p_member_id)
    )
    -- no live/committed intro in EITHER direction, and no RECENT soft dismissal. Identical to the
    -- reciprocal RPC's step (4), so the two paths cannot disagree about what "already introduced"
    -- means. This subsumes the old same-direction dedupe.
    AND NOT EXISTS (
      SELECT 1 FROM public.intro_requests ir
      WHERE ((ir.requester_id = p_member_id AND ir.target_user_id = d.target_user_id)
          OR (ir.requester_id = d.target_user_id AND ir.target_user_id = p_member_id))
        AND (
          ir.status IN ('suggested','queued','pending','accepted','accepted_pending_payment',
                        'admin_pending','approved','declined','rejected','hidden','hidden_permanent')
          OR (ir.status IN ('passed','expired') AND ir.updated_at >= v_cutoff)
        )
    )
  ) f;

  v_n_cand := coalesce(jsonb_array_length(v_candidates), 0);
  IF v_n_cand = 0 THEN
    RETURN jsonb_build_object('placed', false, 'reason', 'no_eligible_candidates',
      'visible_placed', 0, 'reserved_placed', 0, 'dropped', v_supplied);
  END IF;

  ------------------------------------------------------------------ (3) capacity from CARD COUNTS
  -- Status alone decides. batch_id and pair_id are deliberately not consulted: a reciprocal card and
  -- a legacy batch card occupy the same slot.
  SELECT count(*) FILTER (WHERE ir.status = 'queued')
    INTO v_reserved
  FROM public.intro_requests ir
  WHERE ir.requester_id = p_member_id;

  SELECT count(*) INTO v_n_active FROM public.recommendation_batches b
    WHERE b.member_id = p_member_id AND b.state = 'active';
  SELECT count(*) INTO v_n_queued FROM public.recommendation_batches b
    WHERE b.member_id = p_member_id AND b.state = 'queued';
  IF v_n_active > 1 OR v_n_queued > 1 THEN
    RETURN jsonb_build_object('placed', false, 'reason', 'inconsistent_batches');
  END IF;

  SELECT * INTO v_active FROM public.recommendation_batches b
    WHERE b.member_id = p_member_id AND b.state = 'active' FOR UPDATE;
  SELECT * INTO v_queued FROM public.recommendation_batches b
    WHERE b.member_id = p_member_id AND b.state = 'queued' FOR UPDATE;

  -- (085) USABLE visible capacity — see count_usable_visible_cards. Read-only.
  v_visible := public.count_usable_visible_cards(p_member_id);
  v_visible_free  := GREATEST(0, c_max_visible  - v_visible);
  v_reserved_free := GREATEST(0, c_max_reserved - v_reserved);

  -- RESPONSE ELIGIBILITY (migration 081). Unresolved work from an EARLIER release blocks this one.
  -- v_active.batch_id is the envelope: rows already placed into the batch this call appends to are
  -- siblings of this release, not prior work, so they are excluded. When no active batch exists the
  -- exclusion is NULL and every unresolved row counts — which is correct, because a brand-new batch
  -- is by definition a later release than anything already on the member's screen.
  IF public.count_unresolved_introductions(p_member_id, NULL, v_active.batch_id) > 0 THEN
    RETURN jsonb_build_object('placed', false, 'reason', 'unresolved',
      'visible_placed', 0, 'reserved_placed', 0, 'dropped', v_supplied);
  END IF;

  -- Provenance guard: append only into a batch of the SAME source, else skip that tier untouched.
  IF v_visible_free > 0 AND (v_active.batch_id IS NULL OR v_active.batch_source = p_source) THEN
    v_take_v := LEAST(v_visible_free, v_n_cand);
  END IF;
  IF v_reserved_free > 0 AND (v_queued.batch_id IS NULL OR v_queued.batch_source = p_source) THEN
    v_take_r := LEAST(v_reserved_free, v_n_cand - v_take_v);
  END IF;

  IF v_take_v = 0 AND v_take_r = 0 THEN
    -- Fail closed, everything unchanged. 'reserved_full' when the reserved tier was the only one
    -- that could have been used; 'visible_full' when neither tier had room at all.
    RETURN jsonb_build_object(
      'placed', false,
      'reason', CASE
                  WHEN v_visible_free = 0 AND v_reserved_free = 0 THEN 'at_capacity'
                  WHEN v_reserved_free = 0 THEN 'reserved_full'
                  ELSE 'source_mismatch'
                END,
      'visible_placed', 0, 'reserved_placed', 0, 'dropped', v_supplied);
  END IF;

  ------------------------------------------------------------------ (4) writes, contiguous, last
  -- Everything above this line is read-only, so every refusal returns with the database untouched.
  -- There is no DELETE and no discard anywhere below: nothing is ever evicted.
  IF v_take_v > 0 THEN
    IF v_active.batch_id IS NULL THEN
      v_active_id := gen_random_uuid();
      INSERT INTO public.recommendation_batches
        (batch_id, member_id, batch_source, state, reciprocal_batch_id,
         created_at, generated_at, displayed_at, completed_at)
      VALUES (v_active_id, p_member_id, p_source, 'active', p_reciprocal_batch_id,
              v_now, v_now, v_now, NULL);
    ELSE
      v_active_id := v_active.batch_id;   -- append; never a second active batch
    END IF;

    INSERT INTO public.intro_requests
      (requester_id, target_user_id, status, match_reason, batch_id, created_at, updated_at)
    SELECT p_member_id, (c.value ->> 't')::uuid, 'suggested', c.value ->> 'r', v_active_id, v_now, v_now
    FROM jsonb_array_elements(v_candidates) WITH ORDINALITY AS c(value, ordinality)
    WHERE c.ordinality <= v_take_v;
  END IF;

  IF v_take_r > 0 THEN
    IF v_queued.batch_id IS NULL THEN
      v_queued_id := gen_random_uuid();
      INSERT INTO public.recommendation_batches
        (batch_id, member_id, batch_source, state, reciprocal_batch_id,
         created_at, generated_at, displayed_at, completed_at)
      VALUES (v_queued_id, p_member_id, p_source, 'queued', p_reciprocal_batch_id,
              v_now, v_now, NULL, NULL);
    ELSE
      v_queued_id := v_queued.batch_id;   -- append; never a second queued batch
    END IF;

    INSERT INTO public.intro_requests
      (requester_id, target_user_id, status, match_reason, batch_id, created_at, updated_at)
    SELECT p_member_id, (c.value ->> 't')::uuid, 'queued', c.value ->> 'r', v_queued_id, v_now, v_now
    FROM jsonb_array_elements(v_candidates) WITH ORDINALITY AS c(value, ordinality)
    WHERE c.ordinality > v_take_v AND c.ordinality <= v_take_v + v_take_r;
  END IF;

  RETURN jsonb_build_object(
    'placed', true,
    'visible_placed', v_take_v,
    'reserved_placed', v_take_r,
    'dropped', v_supplied - v_take_v - v_take_r,
    'active_batch_id', v_active_id,
    'queued_batch_id', v_queued_id);
END;
$$;

-- ---- promote_queued_rows  (body from migration 085, 138 original lines) ----
CREATE OR REPLACE FUNCTION public.promote_queued_rows(
  p_member_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_max_visible constant integer := 2;   -- THE visible cap. Fixed here; no argument can raise it.
  v_active     public.recommendation_batches%ROWTYPE;
  v_queued     public.recommendation_batches%ROWTYPE;
  v_n_active   integer;
  v_n_queued   integer;
  v_unresolved integer;
  v_visible    integer;
  v_free       integer;
  v_promoted   integer;
  v_leftover   integer;
  v_split      uuid := NULL;
  v_completed  uuid := NULL;
  v_now        timestamptz := now();
BEGIN
  IF p_member_id IS NULL THEN
    RETURN jsonb_build_object('promoted', false, 'reason', 'invalid');
  END IF;

  -- (0) Serialize on the member before reading any count.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_member_id::text, 0));

  SELECT count(*) INTO v_n_active FROM public.recommendation_batches b
    WHERE b.member_id = p_member_id AND b.state = 'active';
  SELECT count(*) INTO v_n_queued FROM public.recommendation_batches b
    WHERE b.member_id = p_member_id AND b.state = 'queued';
  IF v_n_active > 1 OR v_n_queued > 1 THEN
    RETURN jsonb_build_object('promoted', false, 'reason', 'inconsistent_batches');
  END IF;

  SELECT * INTO v_active FROM public.recommendation_batches b
    WHERE b.member_id = p_member_id AND b.state = 'active' FOR UPDATE;

  IF v_active.batch_id IS NOT NULL THEN
    -- UNRESOLVED, SCOPED TO THIS BATCH: one of ITS 'suggested' rows whose requester has not
    -- expressed interest in that target. Rows outside the batch — reciprocal cards above all — are
    -- not this batch's business and never block its completion.
    SELECT count(*) INTO v_unresolved
    FROM public.intro_requests s
    WHERE s.requester_id = p_member_id
      AND s.batch_id = v_active.batch_id
      AND s.status = 'suggested'
      AND NOT EXISTS (
        SELECT 1 FROM public.intro_requests e
        WHERE e.requester_id = p_member_id
          AND e.target_user_id = s.target_user_id
          AND e.status IN ('pending','accepted','accepted_pending_payment','admin_pending','approved')
      );
    IF v_unresolved > 0 THEN
      RETURN jsonb_build_object('promoted', false, 'reason', 'incomplete');
    END IF;

    -- Complete it: archive the lingering 'suggested' rows OF THIS BATCH (they were resolved by
    -- expressed interest, which lives on its own pending/approved row, so nothing is hidden).
    -- Scoped by batch_id, so a pair-governed reciprocal card is never archived here — archiving one
    -- side of a pair would orphan the other.
    UPDATE public.intro_requests SET status = 'archived', updated_at = v_now
      WHERE requester_id = p_member_id AND batch_id = v_active.batch_id AND status = 'suggested';
    UPDATE public.recommendation_batches SET state = 'completed', completed_at = v_now
      WHERE batch_id = v_active.batch_id;
    v_completed := v_active.batch_id;
  END IF;

  SELECT * INTO v_queued FROM public.recommendation_batches b
    WHERE b.member_id = p_member_id AND b.state = 'queued' FOR UPDATE;
  IF v_queued.batch_id IS NULL THEN
    RETURN jsonb_build_object('promoted', false, 'active_completed', v_completed,
      'reason', CASE WHEN v_completed IS NULL THEN 'no_active' ELSE 'empty_queue' END);
  END IF;

  -- (0b) RESPONSE ELIGIBILITY (migration 081). Revealing a QUEUED batch is a later release, so it
  --      requires the member to be genuinely clear. The batch-scoped check above only asked whether
  --      THIS batch was finished; a reciprocal card sitting outside it was explicitly "not this
  --      batch's business" and so could not block the reveal. That was the bypass: a member could be
  --      shown a fresh queued batch while still owing a response on an unrelated card. No exclusion
  --      is passed — nothing in the queued batch is visible yet, so nothing in it can be prior work.
  IF public.count_unresolved_introductions(p_member_id, NULL, NULL) > 0 THEN
    RETURN jsonb_build_object('promoted', false, 'active_completed', v_completed,
      'reason', 'unresolved');
  END IF;

  -- (1) Re-count VISIBLE after completion. Pair-governed reciprocal cards survive it and count.
  -- (085) USABLE visible capacity — see count_usable_visible_cards. Read-only.
  v_visible := public.count_usable_visible_cards(p_member_id);
  v_free := c_max_visible - v_visible;
  IF v_free <= 0 THEN
    -- Nothing is revealed and nothing is discarded: the reservation waits, and a later call (after
    -- the member resolves a visible card) promotes it. The member is never shown more than the cap.
    RETURN jsonb_build_object('promoted', false, 'active_completed', v_completed,
      'reason', 'deferred_capacity');
  END IF;

  -- (2) Reveal only what fits, oldest-first so the reservation that has waited longest is shown.
  UPDATE public.intro_requests SET status = 'suggested', updated_at = v_now
  WHERE id IN (
    SELECT ir.id FROM public.intro_requests ir
    WHERE ir.requester_id = p_member_id AND ir.batch_id = v_queued.batch_id AND ir.status = 'queued'
      -- COMMUNITY BOUNDARY (migration 096). 'queued' is OUTSIDE the discovery grant set and
      -- 'suggested' is INSIDE it, so this UPDATE is itself a discovery transition. Filtering here
      -- means a stale cross-community reservation can never become discoverable, while the
      -- member's valid queued rows in the same call still promote. The stale row is left as-is:
      -- preventing the transition is the requirement; deleting it is not.
      AND public.community_pair_allowed(p_member_id, ir.target_user_id)
    ORDER BY ir.created_at, ir.id
    LIMIT v_free
  );
  GET DIAGNOSTICS v_promoted = ROW_COUNT;

  IF v_promoted = 0 THEN
    -- A queued batch with no queued rows is inconsistent metadata, not a promotion. Close it out
    -- rather than flipping an empty batch to active and reporting a reveal that showed nothing.
    UPDATE public.recommendation_batches SET state = 'completed', completed_at = v_now
      WHERE batch_id = v_queued.batch_id;
    RETURN jsonb_build_object('promoted', false, 'active_completed', v_completed,
      'reason', 'empty_queued_batch');
  END IF;

  -- (3) Flip the batch to ACTIVE first (no other active batch exists at this point) ...
  UPDATE public.recommendation_batches SET state = 'active', displayed_at = v_now
    WHERE batch_id = v_queued.batch_id;

  -- (4) ... then move any un-promoted rows into a NEW queued batch, so every batch's rows share its
  --     state. Done in this order because the one-queued-per-member index would reject an overlap.
  SELECT count(*) INTO v_leftover FROM public.intro_requests ir
    WHERE ir.requester_id = p_member_id AND ir.batch_id = v_queued.batch_id AND ir.status = 'queued';

  IF v_leftover > 0 THEN
    v_split := gen_random_uuid();
    INSERT INTO public.recommendation_batches
      (batch_id, member_id, batch_source, state, reciprocal_batch_id,
       created_at, generated_at, displayed_at, completed_at)
    VALUES
      (v_split, p_member_id, v_queued.batch_source, 'queued', v_queued.reciprocal_batch_id,
       v_queued.created_at, v_queued.generated_at, NULL, NULL);
    UPDATE public.intro_requests SET batch_id = v_split, updated_at = v_now
      WHERE requester_id = p_member_id AND batch_id = v_queued.batch_id AND status = 'queued';
  END IF;

  RETURN jsonb_build_object(
    'promoted', true,
    'active_completed', v_completed,
    'new_active', v_queued.batch_id,
    'split_batch', v_split,
    'count', v_promoted);
END;
$$;

-- ---- materialize_admin_pair  (body from migration 085, 425 original lines) ----
CREATE OR REPLACE FUNCTION public.materialize_admin_pair(
  p_review_batch_id uuid,
  p_member_a        uuid,
  p_member_b        uuid,
  p_batch_a         uuid    DEFAULT NULL,   -- optional: member A's recommendation_batches.batch_id
  p_batch_b         uuid    DEFAULT NULL,   -- optional: member B's recommendation_batches.batch_id
  p_cooldown_days   integer DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_max_visible  constant integer := 2;   -- identical to migration 063; no argument can raise it
  c_max_reserved constant integer := 2;
  c_source       constant text    := 'admin_reciprocal';

  lo uuid; hi uuid;                        -- canonical pair order
  v_now      timestamptz := pg_catalog.now();
  v_cutoff   timestamptz := pg_catalog.now()
                            - pg_catalog.make_interval(days => GREATEST(COALESCE(p_cooldown_days, 30), 0));
  v_batch          record;
  v_prop_lo        record;                 -- review row: recipient = lo, suggested = hi
  v_prop_hi        record;                 -- review row: recipient = hi, suggested = lo
  v_n_lo   integer; v_n_hi integer;        -- approvable proposals per direction (must be exactly 1)
  v_m_lo   integer; v_m_hi integer;        -- already-materialised proposals per direction
  v_live_n integer; v_live_lo integer; v_live_hi integer;
  v_live_pairs integer; v_live_nullpair integer; v_live_badstatus integer;
  v_live_pair_id uuid; v_bad_batch integer;
  v_pair   record;                         -- existing canonical member_pairs row, READ not created
  v_vis_lo integer; v_res_lo integer;
  v_vis_hi integer; v_res_hi integer;
  v_tier   text;
  v_state  text;
  v_pair_id uuid;
  v_batch_lo uuid; v_batch_hi uuid;
  v_bat_lo   record; v_bat_hi record;      -- the member's existing envelope in the target tier
  v_stale_lo boolean; v_stale_hi boolean;  -- envelope holds no live suggested/queued row
  v_retire_lo boolean; v_retire_hi boolean;
  v_comp_lo text; v_comp_hi text;
BEGIN
  ---------------------------------------------------------------- (1) shape of the request
  IF p_review_batch_id IS NULL OR p_member_a IS NULL OR p_member_b IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','missing_argument');
  END IF;
  IF p_member_a = p_member_b THEN
    -- No unique index or CHECK prevents a self-row; this is the only thing that does.
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','self_pair');
  END IF;

  ---------------------------------------------------------------- (2) canonicalise
  lo := LEAST(p_member_a, p_member_b);
  hi := GREATEST(p_member_a, p_member_b);

  ---------------------------------------------------------------- (3) participant advisory locks
  -- Canonical order, so two concurrent approvals sharing a member can never deadlock. Same key
  -- space as migrations 050/063, so this serialises against place_batch_rows,
  -- create_reciprocal_suggestion and promote_queued_rows for the same member.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lo::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text, 0));

  -- COMMUNITY BOUNDARY (migration 096). Under both locks, before any batch_suggestions read or
  -- intro_requests write. Reuses the function's existing 'ineligible' outcome shape, so the
  -- approve-batch caller's outcome handling is unchanged.
  IF NOT public.community_pair_allowed(lo, hi) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','ineligible','detail','cross_community');
  END IF;

  ---------------------------------------------------------------- (4) review batch + both proposals
  SELECT ib.id, ib.status INTO v_batch
  FROM public.introduction_batches ib
  WHERE ib.id = p_review_batch_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','review_batch_not_found');
  END IF;
  IF v_batch.status IS DISTINCT FROM 'pending_review' AND v_batch.status IS DISTINCT FROM 'active' THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','review_batch_not_approvable');
  END IF;

  -- ── PROPOSAL CENSUS ────────────────────────────────────────────────────────────────────────────
  -- EXACTLY ONE approvable row is required in EACH direction. Production has no unique constraint
  -- on batch_suggestions(batch_id, recipient_id, suggested_id), so duplicates are physically
  -- possible; picking one with LIMIT 1 would make the outcome depend on an arbitrary row order and
  -- could materialise against a row the reviewer never saw. Count first; never pick.
  SELECT count(*) INTO v_n_lo FROM public.batch_suggestions bs
  WHERE bs.batch_id = p_review_batch_id AND bs.recipient_id = lo AND bs.suggested_id = hi
    AND bs.status = 'generated' AND bs.materialized_at IS NULL;
  SELECT count(*) INTO v_n_hi FROM public.batch_suggestions bs
  WHERE bs.batch_id = p_review_batch_id AND bs.recipient_id = hi AND bs.suggested_id = lo
    AND bs.status = 'generated' AND bs.materialized_at IS NULL;
  SELECT count(*) INTO v_m_lo FROM public.batch_suggestions bs
  WHERE bs.batch_id = p_review_batch_id AND bs.recipient_id = lo AND bs.suggested_id = hi
    AND bs.materialized_at IS NOT NULL;
  SELECT count(*) INTO v_m_hi FROM public.batch_suggestions bs
  WHERE bs.batch_id = p_review_batch_id AND bs.recipient_id = hi AND bs.suggested_id = lo
    AND bs.materialized_at IS NOT NULL;

  ---------------------------------------------------------------- (5) REPLAY, with exact symmetry
  IF v_m_lo > 0 OR v_m_hi > 0 THEN
    -- Something in this pair was already materialised. It is a valid replay ONLY if the world is
    -- exactly as one successful call leaves it. Every clause below is required.
    IF v_m_lo <> 1 OR v_m_hi <> 1 OR v_n_lo <> 0 OR v_n_hi <> 0 THEN
      RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','materialized_state_inconsistent');
    END IF;

    SELECT mp.id INTO v_pair_id
    FROM public.member_pairs mp WHERE mp.user_a_id = lo AND mp.user_b_id = hi;

    SELECT count(*),
           count(*) FILTER (WHERE ir.requester_id = lo AND ir.target_user_id = hi),
           count(*) FILTER (WHERE ir.requester_id = hi AND ir.target_user_id = lo),
           count(DISTINCT ir.pair_id),
           count(*) FILTER (WHERE ir.pair_id IS NULL),
           count(*) FILTER (WHERE ir.status <> 'suggested'),
           -- min(uuid) is NOT a PostgreSQL aggregate; compare as text and cast back. The
           -- count(DISTINCT ...) above already proves there is exactly one value to pick.
           min(ir.pair_id::text)::uuid
      INTO v_live_n, v_live_lo, v_live_hi, v_live_pairs, v_live_nullpair, v_live_badstatus, v_live_pair_id
    FROM public.intro_requests ir
    WHERE ((ir.requester_id = lo AND ir.target_user_id = hi)
        OR (ir.requester_id = hi AND ir.target_user_id = lo))
      AND ir.status IN ('suggested','queued');

    IF v_live_n <> 2 OR v_live_lo <> 1 OR v_live_hi <> 1
       OR v_live_pairs <> 1 OR v_live_nullpair <> 0 OR v_live_badstatus <> 0
       OR v_live_pair_id IS NULL
       OR v_pair_id IS NULL OR v_live_pair_id IS DISTINCT FROM v_pair_id THEN
      RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','materialized_state_inconsistent');
    END IF;

    -- Each live row must sit in ITS OWN member's ACTIVE admin envelope.
    --
    -- Deliberately NOT `b.reciprocal_batch_id = p_review_batch_id`. That would contradict the
    -- envelope model: a live admin envelope created by review X is legitimately REUSED when review
    -- Y appends a second card, and its reciprocal_batch_id correctly stays X. Requiring Y here made
    -- every retry of that approval report materialized_state_inconsistent for a perfectly healthy
    -- pair. Envelope ownership, state and source are what a card's placement must satisfy; the
    -- CURRENT REVIEW's provenance is proven separately, by v_m_lo = 1 and v_m_hi = 1 above — the two
    -- symmetric batch_suggestions rows under p_review_batch_id, each materialised exactly once.
    SELECT count(*) INTO v_bad_batch
    FROM public.intro_requests ir
    WHERE ((ir.requester_id = lo AND ir.target_user_id = hi)
        OR (ir.requester_id = hi AND ir.target_user_id = lo))
      AND ir.status = 'suggested'
      AND NOT EXISTS (
        SELECT 1 FROM public.recommendation_batches b
        WHERE b.batch_id = ir.batch_id
          AND b.member_id = ir.requester_id          -- the envelope belongs to the card's owner
          AND b.state = 'active'                      -- and is the member's live envelope
          AND b.batch_source = c_source);             -- and was produced by the admin path
    IF v_bad_batch <> 0 THEN
      RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','materialized_state_inconsistent');
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'outcome','already_materialized','pair_id', v_pair_id, 'review_batch_id', p_review_batch_id);
  END IF;

  ---------------------------------------------------------------- (6) exactly one approvable each
  IF v_n_lo > 1 OR v_n_hi > 1 THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','duplicate_proposal');
  END IF;
  IF v_n_lo <> 1 OR v_n_hi <> 1 THEN
    -- Missing, dropped, passed, hidden, or already shown on one side. Never materialise one-sidedly.
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','proposal_not_symmetric');
  END IF;

  SELECT bs.id, bs.match_score, bs.reason INTO v_prop_lo
  FROM public.batch_suggestions bs
  WHERE bs.batch_id = p_review_batch_id AND bs.recipient_id = lo AND bs.suggested_id = hi
    AND bs.status = 'generated' AND bs.materialized_at IS NULL
  FOR UPDATE;
  SELECT bs.id, bs.match_score, bs.reason INTO v_prop_hi
  FROM public.batch_suggestions bs
  WHERE bs.batch_id = p_review_batch_id AND bs.recipient_id = hi AND bs.suggested_id = lo
    AND bs.status = 'generated' AND bs.materialized_at IS NULL
  FOR UPDATE;

  ---------------------------------------------------------------- (7) both members still eligible
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = lo AND p.account_status = 'active' AND p.profile_complete = true
      AND COALESCE(p.is_test_account,false) = false AND COALESCE(p.is_admin,false) = false
      AND COALESCE(p.matching_paused,false) = false
  ) OR NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = hi AND p.account_status = 'active' AND p.profile_complete = true
      AND COALESCE(p.is_test_account,false) = false AND COALESCE(p.is_admin,false) = false
      AND COALESCE(p.matching_paused,false) = false
  ) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','ineligible');
  END IF;

  ---------------------------------------------------------------- (8) blocking, both directions
  IF EXISTS (
    SELECT 1 FROM public.blocked_users bu
    WHERE (bu.user_id = lo AND bu.blocked_user_id = hi)
       OR (bu.user_id = hi AND bu.blocked_user_id = lo)
  ) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','blocked');
  END IF;

  ---------------------------------------------------------------- (9) already connected
  IF EXISTS (
    SELECT 1 FROM public.matches m
    WHERE (m.user_a_id = lo AND m.user_b_id = hi)
       OR (m.user_a_id = hi AND m.user_b_id = lo)
  ) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','already_matched');
  END IF;

  ---------------------------------------------------------------- (10) live rows / hard history
  -- Pure existence probes (no row is selected), so no LIMIT appears anywhere in this function.
  IF EXISTS (
    SELECT 1 FROM public.intro_requests ir
    WHERE ((ir.requester_id = lo AND ir.target_user_id = hi)
        OR (ir.requester_id = hi AND ir.target_user_id = lo))
      AND ir.status IN ('suggested','queued','pending','accepted',
                        'accepted_pending_payment','admin_pending','approved')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','exists_active');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.intro_requests ir
    WHERE ((ir.requester_id = lo AND ir.target_user_id = hi)
        OR (ir.requester_id = hi AND ir.target_user_id = lo))
      AND ir.status IN ('declined','rejected','hidden','hidden_permanent')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','history');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.intro_requests ir
    WHERE ((ir.requester_id = lo AND ir.target_user_id = hi)
        OR (ir.requester_id = hi AND ir.target_user_id = lo))
      AND ir.status IN ('passed','expired') AND ir.updated_at >= v_cutoff
  ) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','cooldown');
  END IF;

  ---------------------------------------------------------------- (11) normalised same-company
  -- Mirrors lib/matching/same-company.ts: lowercase, trim, strip common corporate suffixes; an
  -- empty company on either side is permissive (not same-company). Enforced HERE as well as at
  -- generation, because a member can change employer between review and approval.
  SELECT lower(btrim(regexp_replace(COALESCE(p.company,''),
           '[,.]?\s*(llc|inc|corp|ltd|p\.c\.|llp|s\.a\.|gmbh|ag|limited|incorporated|corporation|company)\.?\s*$',
           '', 'i')))
    INTO v_comp_lo FROM public.profiles p WHERE p.id = lo;
  SELECT lower(btrim(regexp_replace(COALESCE(p.company,''),
           '[,.]?\s*(llc|inc|corp|ltd|p\.c\.|llp|s\.a\.|gmbh|ag|limited|incorporated|corporation|company)\.?\s*$',
           '', 'i')))
    INTO v_comp_hi FROM public.profiles p WHERE p.id = hi;
  IF v_comp_lo <> '' AND v_comp_lo = v_comp_hi THEN
    RETURN pg_catalog.jsonb_build_object('outcome','same_company');
  END IF;

  ---------------------------------------------------------------- (12) capacity for BOTH members
  -- Reserved counts are read too, but only to report why a refusal happened. They can never make a
  -- pair placeable: see the VISIBLE TIER ONLY note in the header.
  -- (085) USABLE visible capacity for both members — see count_usable_visible_cards. Read-only;
  -- the reserved tier is counted exactly as before and still cannot make a pair placeable.
  SELECT count(*) FILTER (WHERE ir.status = 'queued') INTO v_res_lo
  FROM public.intro_requests ir WHERE ir.requester_id = lo;
  SELECT count(*) FILTER (WHERE ir.status = 'queued') INTO v_res_hi
  FROM public.intro_requests ir WHERE ir.requester_id = hi;
  v_vis_lo := public.count_usable_visible_cards(lo);
  v_vis_hi := public.count_usable_visible_cards(hi);

  ---------------------------------------------------------------- (12b) RESPONSE ELIGIBILITY (081)
  -- An admin pair is a NEW release for both members, so neither gets an envelope exclusion. It
  -- refuses BEFORE any write, so a refusal can never leave one member holding a card the other does
  -- not have — the asymmetry this whole function exists to prevent.
  IF public.count_unresolved_introductions(lo, NULL, NULL) > 0
     OR public.count_unresolved_introductions(hi, NULL, NULL) > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome','unresolved',
      'unresolved_lo', public.count_unresolved_introductions(lo, NULL, NULL),
      'unresolved_hi', public.count_unresolved_introductions(hi, NULL, NULL));
  END IF;

  ---------------------------------------------------------------- (13) the ONE placeable tier
  -- Capacity alone decides the tier here. Envelope usability is a SEPARATE question, settled in
  -- step (15) where a stale envelope can be retired rather than blocking the member.
  IF v_vis_lo < c_max_visible AND v_vis_hi < c_max_visible THEN
    v_tier := 'suggested'; v_state := 'active';
  ELSE
    RETURN pg_catalog.jsonb_build_object(
      'outcome','capacity',
      'visible_free_lo', GREATEST(0, c_max_visible  - v_vis_lo),
      'visible_free_hi', GREATEST(0, c_max_visible  - v_vis_hi),
      'reserved_free_lo',GREATEST(0, c_max_reserved - v_res_lo),
      'reserved_free_hi',GREATEST(0, c_max_reserved - v_res_hi));
  END IF;

  ---------------------------------------------------------------- (14) member_pairs: READ, not create
  -- Deliberately a plain SELECT. Creating the row here and refusing below would leave it behind,
  -- because RETURN does not roll back. The row is created only in the write phase.
  SELECT mp.id, mp.status, mp.last_recommended_at INTO v_pair
  FROM public.member_pairs mp
  WHERE mp.user_a_id = lo AND mp.user_b_id = hi
  FOR UPDATE;

  IF FOUND THEN
    -- Status policy (see the header). Terminal statuses are never reactivated.
    IF v_pair.status = 'matched' THEN
      RETURN pg_catalog.jsonb_build_object('outcome','already_matched','detail','pair_status_matched');
    ELSIF v_pair.status = 'blocked' THEN
      RETURN pg_catalog.jsonb_build_object('outcome','blocked','detail','pair_status_blocked');
    ELSIF v_pair.status = 'ineligible' THEN
      RETURN pg_catalog.jsonb_build_object('outcome','ineligible','detail','pair_status_ineligible');
    ELSIF v_pair.status = 'superseded' THEN
      RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','pair_status_superseded');
    ELSIF v_pair.status NOT IN ('active','passed','expired') THEN
      RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','pair_status_unknown');
    END IF;

    IF v_pair.last_recommended_at IS NOT NULL AND v_pair.last_recommended_at >= v_cutoff THEN
      RETURN pg_catalog.jsonb_build_object('outcome','cooldown','detail','pair_cooldown');
    END IF;
  END IF;

  ---------------------------------------------------------------- (15) envelopes: READ + decide
  -- Unique-key reads (one active row per member, by partial unique index). No ordering, no LIMIT.
  SELECT b.batch_id, b.batch_source, b.reciprocal_batch_id INTO v_bat_lo
  FROM public.recommendation_batches b
  WHERE b.member_id = lo AND b.state = v_state
  FOR UPDATE;
  SELECT b.batch_id, b.batch_source, b.reciprocal_batch_id INTO v_bat_hi
  FROM public.recommendation_batches b
  WHERE b.member_id = hi AND b.state = v_state
  FOR UPDATE;

  -- Is the envelope STALE — i.e. does it still hold anything the member can see or is waiting on?
  -- Only a stale envelope may be retired, and retiring one can never hide a card.
  v_stale_lo := FALSE; v_stale_hi := FALSE;
  IF v_bat_lo.batch_id IS NOT NULL THEN
    SELECT NOT EXISTS (SELECT 1 FROM public.intro_requests ir
                       WHERE ir.batch_id = v_bat_lo.batch_id AND ir.status IN ('suggested','queued'))
      INTO v_stale_lo;
  END IF;
  IF v_bat_hi.batch_id IS NOT NULL THEN
    SELECT NOT EXISTS (SELECT 1 FROM public.intro_requests ir
                       WHERE ir.batch_id = v_bat_hi.batch_id AND ir.status IN ('suggested','queued'))
      INTO v_stale_hi;
  END IF;

  -- A LIVE envelope from another producer cannot take an admin card: appending would make
  -- batch_source a lie, and retiring it would hide cards the member can currently see.
  IF (v_bat_lo.batch_id IS NOT NULL AND NOT v_stale_lo AND v_bat_lo.batch_source IS DISTINCT FROM c_source)
     OR (v_bat_hi.batch_id IS NOT NULL AND NOT v_stale_hi AND v_bat_hi.batch_source IS DISTINCT FROM c_source) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','capacity','detail','active_batch_source_conflict');
  END IF;

  -- Reuse only a LIVE admin envelope. A stale one (any source) is retired in the write phase, and a
  -- fresh envelope is created stamped with THIS review batch. reciprocal_batch_id is never rewritten.
  v_batch_lo := CASE WHEN v_bat_lo.batch_id IS NOT NULL AND NOT v_stale_lo THEN v_bat_lo.batch_id END;
  v_batch_hi := CASE WHEN v_bat_hi.batch_id IS NOT NULL AND NOT v_stale_hi THEN v_bat_hi.batch_id END;
  v_retire_lo := (v_bat_lo.batch_id IS NOT NULL AND v_stale_lo);
  v_retire_hi := (v_bat_hi.batch_id IS NOT NULL AND v_stale_hi);

  -- p_batch_a belongs to p_member_a, which may be either side of canonical order — map it, never
  -- assume. An id supplied for a member whose envelope will be newly created is a mismatch: the
  -- caller cannot have known an id that does not exist yet.
  IF (p_batch_a IS NOT NULL AND p_batch_a IS DISTINCT FROM
        (CASE WHEN p_member_a = lo THEN v_batch_lo ELSE v_batch_hi END))
     OR (p_batch_b IS NOT NULL AND p_batch_b IS DISTINCT FROM
        (CASE WHEN p_member_b = lo THEN v_batch_lo ELSE v_batch_hi END)) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','batch_id_mismatch');
  END IF;

  ---------------------------------------------------------------- (16) ════ FIRST WRITE ════
  -- Everything above this line is READ-ONLY. Every refusal returns with the database untouched.
  INSERT INTO public.member_pairs (user_a_id, user_b_id, source)
  VALUES (lo, hi, 'admin')
  ON CONFLICT (user_a_id, user_b_id) DO NOTHING;

  SELECT mp.id INTO v_pair_id
  FROM public.member_pairs mp
  WHERE mp.user_a_id = lo AND mp.user_b_id = hi
  FOR UPDATE;

  -- Retire a stale envelope FIRST: the one-active-per-member partial unique index would reject an
  -- overlap. This is the same transition promote_queued_rows makes, and it hides nothing, because
  -- step (15) proved the envelope holds no live row.
  IF v_retire_lo THEN
    UPDATE public.recommendation_batches
    SET state = 'completed', completed_at = v_now
    WHERE batch_id = v_bat_lo.batch_id;
  END IF;
  IF v_retire_hi THEN
    UPDATE public.recommendation_batches
    SET state = 'completed', completed_at = v_now
    WHERE batch_id = v_bat_hi.batch_id;
  END IF;

  IF v_batch_lo IS NULL THEN
    v_batch_lo := pg_catalog.gen_random_uuid();
    INSERT INTO public.recommendation_batches
      (batch_id, member_id, batch_source, state, reciprocal_batch_id,
       created_at, generated_at, displayed_at, completed_at)
    VALUES (v_batch_lo, lo, c_source, v_state, p_review_batch_id, v_now, v_now, v_now, NULL);
  END IF;
  IF v_batch_hi IS NULL THEN
    v_batch_hi := pg_catalog.gen_random_uuid();
    INSERT INTO public.recommendation_batches
      (batch_id, member_id, batch_source, state, reciprocal_batch_id,
       created_at, generated_at, displayed_at, completed_at)
    VALUES (v_batch_hi, hi, c_source, v_state, p_review_batch_id, v_now, v_now, v_now, NULL);
  END IF;

  -- Each side carries its OWN member-level batch_id. Same status, same pair_id, same transaction:
  -- one direction cannot exist without the other.
  INSERT INTO public.intro_requests
    (requester_id, target_user_id, status, is_admin_initiated, match_reason,
     match_score, pair_id, batch_id, created_at, updated_at)
  VALUES
    (lo, hi, v_tier, true, v_prop_lo.reason,
     COALESCE(pg_catalog.round(v_prop_lo.match_score)::integer, 0), v_pair_id, v_batch_lo, v_now, v_now),
    (hi, lo, v_tier, true, v_prop_hi.reason,
     COALESCE(pg_catalog.round(v_prop_hi.match_score)::integer, 0), v_pair_id, v_batch_hi, v_now, v_now);

  UPDATE public.member_pairs
  SET recommend_count      = recommend_count + 1,
      last_recommended_at  = v_now,
      first_recommended_at = COALESCE(first_recommended_at, v_now),
      status               = 'active'
  WHERE id = v_pair_id;

  -- Only now, and only for a pair that actually landed. A rejected pair returned above with its
  -- review rows still 'generated', so it stays visible and re-approvable.
  UPDATE public.batch_suggestions
  SET status = 'shown', shown_at = COALESCE(shown_at, v_now), materialized_at = v_now
  WHERE id IN (v_prop_lo.id, v_prop_hi.id);

  ---------------------------------------------------------------- (18) structured result
  RETURN pg_catalog.jsonb_build_object(
    'outcome','created',
    'tier', v_tier,
    'pair_id', v_pair_id,
    'review_batch_id', p_review_batch_id,
    'batch_id_lo', v_batch_lo,
    'batch_id_hi', v_batch_hi);
END;
$$;

-- ---- finalize_mutual_match_atomic  (body from migration 067, 82 original lines) ----
CREATE OR REPLACE FUNCTION public.finalize_mutual_match_atomic(
  p_user_a            uuid,
  p_user_b            uuid,
  p_admin_facilitated boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  lo uuid; hi uuid;
  v_n_acting integer;
  v_n_other  integer;
  v_pair     record;
  v_rpc      record;
BEGIN
  ---------------------------------------------------------------- (1) shape
  IF p_user_a IS NULL OR p_user_b IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','missing_argument');
  END IF;
  IF p_user_a = p_user_b THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','self_pair');
  END IF;

  ---------------------------------------------------------------- (2) canonical order + locks
  lo := LEAST(p_user_a, p_user_b);
  hi := GREATEST(p_user_a, p_user_b);
  -- IDENTICAL keys and order to migrations 050/063/064/066, so expiry and finalization serialise.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lo::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text, 0));

  -- COMMUNITY BOUNDARY (migration 096) — FIRST of two layers, and the one that actually fires.
  -- It must refuse BEFORE delegating: the delegate signals failure through error_code, and
  -- lib/introductions/finalizeMutualMatch.ts only recognises insufficient_credits_a/_b and
  -- duplicate_match, so an unrecognised code would fall through to an undefined match_id. The
  -- existing 'invalid' outcome is already handled by every caller as a 409, so no Stage 1b
  -- TypeScript change is required for this guard.
  IF NOT public.community_pair_allowed(p_user_a, p_user_b) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','cross_community');
  END IF;

  ---------------------------------------------------------------- (3) already matched?
  -- Idempotent: a retry after a successful finalization reports the existing match and writes
  -- nothing further. The delegate also guards this with 'duplicate_match'; both are kept.
  IF EXISTS (
    SELECT 1 FROM public.matches m
    WHERE (m.user_a_id = lo AND m.user_b_id = hi) OR (m.user_a_id = hi AND m.user_b_id = lo)
  ) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','already_matched');
  END IF;

  ---------------------------------------------------------------- (4) pair state, under the lock
  SELECT mp.id, mp.status INTO v_pair
  FROM public.member_pairs mp
  WHERE mp.user_a_id = lo AND mp.user_b_id = hi
  FOR UPDATE;
  IF FOUND AND v_pair.status IN ('expired','blocked') THEN
    -- Expiry (066) won the race, or the pair is blocked. Refuse before anything is written.
    RETURN pg_catalog.jsonb_build_object('outcome','not_consented','detail','pair_' || v_pair.status);
  END IF;

  ---------------------------------------------------------------- (5) CONSENT, re-read in-transaction
  -- This is the authorization. The application's earlier read is advisory only; this one decides.
  -- Rows are LOCKED so neither side can change between this check and the delegate below.
  SELECT count(*) INTO v_n_acting
  FROM public.intro_requests ir
  WHERE ir.requester_id = p_user_a AND ir.target_user_id = p_user_b
    AND ir.status IN ('approved','accepted');

  SELECT count(*) INTO v_n_other
  FROM public.intro_requests ir
  WHERE ir.requester_id = p_user_b AND ir.target_user_id = p_user_a
    AND ir.status IN ('approved','accepted','pending');

  IF v_n_acting < 1 OR v_n_other < 1 THEN
    RETURN pg_catalog.jsonb_build_object('outcome','not_consented','detail','consent_missing');
  END IF;

  -- Lock the qualifying rows so an expiry that arrives mid-transaction blocks rather than slipping
  -- between this check and the delegate's writes.
  PERFORM 1 FROM public.intro_requests ir
  WHERE ((ir.requester_id = p_user_a AND ir.target_user_id = p_user_b)
      OR (ir.requester_id = p_user_b AND ir.target_user_id = p_user_a))
    AND ir.status IN ('approved','accepted','pending')
  FOR UPDATE;

  ---------------------------------------------------------------- (6) DELEGATE, same transaction
  -- The canonical writer. Credits, match, conversation and every existing production guard inside
  -- it are unchanged; nothing is reimplemented here.
  SELECT * INTO v_rpc
  FROM public.consume_credits_and_create_match(p_user_a, p_user_b, p_admin_facilitated);

  IF v_rpc.error_code IS NOT NULL THEN
    -- Pass the delegate's own coarse code straight through; the caller already handles each one.
    RETURN pg_catalog.jsonb_build_object('outcome','delegate_error','error_code', v_rpc.error_code);
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'outcome','finalized',
    'match_id', v_rpc.match_id,
    'conversation_id', v_rpc.conversation_id);
END;
$$;

-- ---- consume_credits_and_create_match  (body from migration 087, 162 original lines) ----
CREATE OR REPLACE FUNCTION public.consume_credits_and_create_match(
  p_user_a uuid,
  p_user_b uuid,
  p_admin_facilitated boolean DEFAULT false
)
RETURNS TABLE (match_id uuid, conversation_id uuid, error_code text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_match_id        uuid;
  v_conversation_id uuid;
  v_admin_count     integer;
  v_participants    integer;
  v_chargeable      boolean;
  r                 record;
  v_free_a          integer;
  v_prem_a          integer;
  v_free_b          integer;
  v_prem_b          integer;
  v_funded_a        text;
  v_funded_b        text;
BEGIN
  BEGIN
    -- WHO ARE THESE PEOPLE? Unchanged from 072: FOR SHARE so is_admin cannot change between the
    -- decision and the debits. p_admin_facilitated has no authority over money.
    SELECT count(*) FILTER (WHERE pr.is_admin IS TRUE), count(*)
      INTO v_admin_count, v_participants
    FROM (
      SELECT p.id, p.is_admin
      FROM public.profiles p
      WHERE p.id IN (p_user_a, p_user_b)
      ORDER BY p.id
      FOR SHARE
    ) pr;

    IF v_participants < 2 THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'participant_not_found'::text;
      RETURN;
    END IF;

    v_chargeable := (v_admin_count = 0);

    -- ── CANONICAL PAIR LOCK + BOTH-ORDER DUPLICATE CHECK ───────────────────────────────────
    -- matches_unique_pair is UNIQUE (user_a_id, user_b_id) and is NOT canonical, so (A,B) and
    -- (B,A) are different rows. Two concurrent callers in OPPOSITE argument order therefore both
    -- passed the constraint and both created a match, charging each member twice. The supported
    -- entry point (finalize_mutual_match_atomic) canonicalises and guards this, but a function
    -- that debits credits should not depend on its caller for that.
    --
    -- One advisory lock keyed on the UNORDERED pair serialises the two callers; the existence
    -- check then catches the loser before any debit. Both are keyed on LEAST/GREATEST, so
    -- argument order cannot change the outcome. There is exactly one key per pair, so this
    -- introduces no new deadlock class.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        LEAST(p_user_a, p_user_b)::text || ':' || GREATEST(p_user_a, p_user_b)::text, 0));

    -- COMMUNITY BOUNDARY (migration 096) — SECOND, SEALED layer. Normally unreachable for a
    -- cross-community request because finalize_mutual_match_atomic refuses first, and migration 068
    -- revoked EXECUTE on this function from PUBLIC, anon, authenticated AND service_role, leaving
    -- the definer wrapper as the only caller. It exists so the LOWEST writer of a matches row is
    -- itself authoritative rather than trusting its one caller.
    IF NOT public.community_pair_allowed(p_user_a, p_user_b) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'cross_community'::text;
      RETURN;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.matches m
      WHERE (m.user_a_id = p_user_a AND m.user_b_id = p_user_b)
         OR (m.user_a_id = p_user_b AND m.user_b_id = p_user_a)
    ) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'duplicate_match'::text;
      RETURN;
    END IF;

    IF v_chargeable THEN
      -- DETERMINISTIC LOCK ORDER + PRE-STATE. Both rows are locked by ascending user_id,
      -- independent of which argument is A and which is B, so concurrent (A,B) and (B,A)
      -- finalizations queue instead of deadlocking. The same pass captures the pre-debit buckets,
      -- which is what decides — and records — which bucket funds each charge. A member with no
      -- credit row simply never sets its variables and falls through to insufficient_credits,
      -- exactly as the 072 UPDATE-affects-zero-rows path did.
      FOR r IN
        SELECT mc.user_id,
               COALESCE(mc.free_credits, 0)    AS f,
               COALESCE(mc.premium_credits, 0) AS p
        FROM public.meeting_credits mc
        WHERE mc.user_id IN (p_user_a, p_user_b)
        ORDER BY mc.user_id
        FOR UPDATE
      LOOP
        IF r.user_id = p_user_a THEN v_free_a := r.f; v_prem_a := r.p; END IF;
        IF r.user_id = p_user_b THEN v_free_b := r.f; v_prem_b := r.p; END IF;
      END LOOP;

      -- INCLUDED FIRST, PURCHASED SECOND, NEVER BOTH.
      v_funded_a := CASE WHEN COALESCE(v_free_a, 0) > 0 THEN 'included'
                         WHEN COALESCE(v_prem_a, 0) > 0 THEN 'purchased'
                         ELSE NULL END;
      v_funded_b := CASE WHEN COALESCE(v_free_b, 0) > 0 THEN 'included'
                         WHEN COALESCE(v_prem_b, 0) > 0 THEN 'purchased'
                         ELSE NULL END;

      -- MEMBER A. Nothing written yet, so a shortfall simply returns.
      IF v_funded_a IS NULL THEN
        RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'insufficient_credits_a'::text;
        RETURN;
      END IF;

      UPDATE public.meeting_credits
      SET free_credits    = CASE WHEN v_funded_a = 'included'
                                 THEN COALESCE(free_credits, 0) - 1
                                 ELSE COALESCE(free_credits, 0) END,
          premium_credits = CASE WHEN v_funded_a = 'purchased'
                                 THEN COALESCE(premium_credits, 0) - 1
                                 ELSE COALESCE(premium_credits, 0) END,
          balance         = COALESCE(free_credits, 0) + COALESCE(premium_credits, 0) - 1
      WHERE user_id = p_user_a
        AND COALESCE(free_credits, 0) + COALESCE(premium_credits, 0) >= 1;

      IF NOT FOUND THEN
        RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'insufficient_credits_a'::text;
        RETURN;
      END IF;

      -- MEMBER B. A HAS been charged by this point; RAISE is what unwinds that charge.
      IF v_funded_b IS NULL THEN
        RAISE EXCEPTION 'insufficient_credits_b' USING ERRCODE = 'P0001';
      END IF;

      UPDATE public.meeting_credits
      SET free_credits    = CASE WHEN v_funded_b = 'included'
                                 THEN COALESCE(free_credits, 0) - 1
                                 ELSE COALESCE(free_credits, 0) END,
          premium_credits = CASE WHEN v_funded_b = 'purchased'
                                 THEN COALESCE(premium_credits, 0) - 1
                                 ELSE COALESCE(premium_credits, 0) END,
          balance         = COALESCE(free_credits, 0) + COALESCE(premium_credits, 0) - 1
      WHERE user_id = p_user_b
        AND COALESCE(free_credits, 0) + COALESCE(premium_credits, 0) >= 1;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'insufficient_credits_b' USING ERRCODE = 'P0001';
      END IF;
    END IF;

    INSERT INTO public.matches (user_a_id, user_b_id, admin_facilitated)
    VALUES (p_user_a, p_user_b, p_admin_facilitated)
    RETURNING id INTO v_match_id;

    INSERT INTO public.conversations (match_id) VALUES (v_match_id) RETURNING id INTO v_conversation_id;

    IF v_chargeable THEN
      INSERT INTO public.credit_transactions
        (user_id, amount, type, note, event_key, source_kind, source_id, funded_from)
      VALUES
        (p_user_a, -1, 'deduction', 'Mutual introduction finalized',
         'match_debit:' || v_match_id::text || ':' || p_user_a::text, 'match_debit', v_match_id, v_funded_a),
        (p_user_b, -1, 'deduction', 'Mutual introduction finalized',
         'match_debit:' || v_match_id::text || ':' || p_user_b::text, 'match_debit', v_match_id, v_funded_b);
    ELSE
      INSERT INTO public.credit_transactions
        (user_id, amount, type, note, event_key, source_kind, source_id, funded_from)
      VALUES
        (p_user_a, 0, 'exempt', 'Admin participant - no charge',
         'match_exempt:' || v_match_id::text || ':' || p_user_a::text, 'match_exempt_admin', v_match_id, NULL),
        (p_user_b, 0, 'exempt', 'Admin participant - no charge',
         'match_exempt:' || v_match_id::text || ':' || p_user_b::text, 'match_exempt_admin', v_match_id, NULL);
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'duplicate_match'::text;
      RETURN;
    WHEN raise_exception THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, SQLERRM::text;
      RETURN;
  END;

  RETURN QUERY SELECT v_match_id, v_conversation_id, NULL::text;
END;
$function$;

-- ── SECTION 2 — create_gated_match ───────────────────────────────────────────────────────────
--
-- The purpose-neutral primitive for the three flows that today INSERT a matches row DIRECTLY from
-- TypeScript: adminForceMatch, /api/admin/facilitate-intro, and lib/opportunities/connect.ts.
-- Stage 1b converts those callers; this migration only creates the primitive they will use.
--
-- WHY NOT REUSE finalize_mutual_match_atomic. It was the obvious candidate and it is wrong on three
-- counts, each independently disqualifying. (1) CONSENT: it requires an approved intro_requests row
-- in each direction and returns 'not_consented' otherwise — none of the three flows has any
-- intro_requests row, and connect.ts actively REFUSES when one exists, so all three would fail
-- 100% of the time. (2) CREDITS: its delegate charges BOTH members unless a participant is
-- is_admin, and its own comment records that p_admin_facilitated "has no authority over money" —
-- all three flows currently charge nothing, and facilitate-intro had its debit deliberately
-- DELETED. (3) COLUMNS: the delegate writes only (user_a_id, user_b_id, admin_facilitated), while
-- connect.ts writes is_opportunity_initiated / opportunity_id / matched_at / admin_notes, which
-- lib/opportunities/caps.ts and rateLimits.ts read for delivery caps and re-delivery blocking.
--
-- So this function does the ONE thing those flows share — an atomic, community-gated match plus its
-- conversation — and nothing else. No credits. No consent. No intro_request requirement. No
-- notifications, emails or system messages: those stay in the callers, which is where their
-- differing behaviour already lives.
CREATE OR REPLACE FUNCTION public.create_gated_match(
  p_user_a uuid,
  p_user_b uuid,
  p_admin_facilitated boolean DEFAULT false,
  p_status text DEFAULT 'active',
  p_admin_notes text DEFAULT NULL,
  p_matched_at timestamptz DEFAULT NULL,
  p_is_opportunity_initiated boolean DEFAULT false,
  p_opportunity_id uuid DEFAULT NULL,
  p_suggested_prompts jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  lo uuid;
  hi uuid;
  v_match_id uuid;
  v_conversation_id uuid;
BEGIN
  IF p_user_a IS NULL OR p_user_b IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','missing_argument');
  END IF;
  IF p_user_a = p_user_b THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','self_pair');
  END IF;

  lo := LEAST(p_user_a, p_user_b);
  hi := GREATEST(p_user_a, p_user_b);

  -- Canonical ordering, the same discipline create_reciprocal_suggestion and materialize_admin_pair
  -- use, so this function serialises against them for a shared member and introduces no new
  -- deadlock class.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lo::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text, 0));

  -- THE BOUNDARY. Under both locks, in the transaction that writes. service_role cannot bypass it:
  -- service_role bypasses RLS, not a function body, and after Stage 1b there is no other route to a
  -- matches row from these flows.
  IF NOT public.community_pair_allowed(p_user_a, p_user_b) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','ineligible','detail','cross_community');
  END IF;

  -- Idempotent: an existing match in either column order is success, not a duplicate row.
  SELECT m.id INTO v_match_id
  FROM public.matches m
  WHERE (m.user_a_id = p_user_a AND m.user_b_id = p_user_b)
     OR (m.user_a_id = p_user_b AND m.user_b_id = p_user_a)
  LIMIT 1;

  IF v_match_id IS NOT NULL THEN
    SELECT c.id INTO v_conversation_id FROM public.conversations c WHERE c.match_id = v_match_id LIMIT 1;
    RETURN pg_catalog.jsonb_build_object(
      'outcome','already_matched','match_id', v_match_id, 'conversation_id', v_conversation_id);
  END IF;

  INSERT INTO public.matches
    (user_a_id, user_b_id, status, admin_facilitated, admin_notes, matched_at,
     is_opportunity_initiated, opportunity_id)
  VALUES
    (p_user_a, p_user_b, COALESCE(p_status,'active'), COALESCE(p_admin_facilitated,false),
     p_admin_notes, COALESCE(p_matched_at, pg_catalog.now()),
     COALESCE(p_is_opportunity_initiated,false), p_opportunity_id)
  RETURNING id INTO v_match_id;

  -- Same statement block as the match: a match without its conversation is not a reachable state.
  INSERT INTO public.conversations (match_id, suggested_prompts)
  VALUES (v_match_id, COALESCE(p_suggested_prompts, '[]'::jsonb))
  RETURNING id INTO v_conversation_id;

  RETURN pg_catalog.jsonb_build_object(
    'outcome','created','match_id', v_match_id, 'conversation_id', v_conversation_id);
END
$$;

REVOKE ALL ON FUNCTION public.create_gated_match(uuid, uuid, boolean, text, text, timestamptz, boolean, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_gated_match(uuid, uuid, boolean, text, text, timestamptz, boolean, uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.create_gated_match(uuid, uuid, boolean, text, text, timestamptz, boolean, uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_gated_match(uuid, uuid, boolean, text, text, timestamptz, boolean, uuid, jsonb) TO service_role;

COMMENT ON FUNCTION public.create_gated_match(uuid, uuid, boolean, text, text, timestamptz, boolean, uuid, jsonb) IS
  'Atomic, community-gated match + conversation for the flows that previously INSERTed matches '
  'directly (Force Match, facilitate-intro, opportunity connect). Charges NO credits, requires NO '
  'consent and NO intro_request, and sends nothing — those stay in the callers. Deliberately NOT '
  'finalize_mutual_match_atomic, which requires consent, charges both members, and drops the '
  'opportunity columns. service_role EXECUTE only. Migration 096.';


-- ── SECTION 3 — create_support_match ─────────────────────────────────────────────────────────
--
-- The ONLY sanctioned cross-community relationship, for the two platform/support paths:
-- lib/onboarding/welcomeFromAdmin.ts and /api/admin/issues/[id]/reply. Stage 1b converts them.
--
-- The exemption is keyed on profiles.is_admin = TRUE, read FOR SHARE so it cannot change between
-- the decision and the write. NOT on ADMIN_EMAIL: an email is mutable application configuration,
-- and a security boundary must not rest on a string in an env var. (Live verification confirmed the
-- platform account carries a durable is_admin = true.)
--
-- WHY A DEDICATED FUNCTION RATHER THAN A SHARED is_platform_account() HELPER, OR A BYPASS FLAG ON
-- create_gated_match: a general-purpose predicate is a callable bypass waiting for a caller, and a
-- boolean parameter on an ordinary writer is precisely the "admin bypasses community" mechanism
-- this design forbids. Keeping the exemption INSIDE a function that only ever creates an
-- admin<->member pair means there is no argument any caller can pass to pair two ordinary members
-- across the wall. p_platform_user is not trusted because the caller says so — it is verified.
CREATE OR REPLACE FUNCTION public.create_support_match(
  p_platform_user uuid,
  p_member uuid,
  p_admin_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  lo uuid;
  hi uuid;
  v_is_admin boolean;
  v_member_ok boolean;
  v_match_id uuid;
  v_conversation_id uuid;
BEGIN
  IF p_platform_user IS NULL OR p_member IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','missing_argument');
  END IF;
  IF p_platform_user = p_member THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','self_pair');
  END IF;

  lo := LEAST(p_platform_user, p_member);
  hi := GREATEST(p_platform_user, p_member);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lo::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text, 0));

  -- THE EXEMPTION, AND ITS ONLY CONDITION. The named platform participant must actually be the
  -- platform account. FOR SHARE pins is_admin for the rest of the transaction.
  SELECT p.is_admin INTO v_is_admin
  FROM public.profiles p WHERE p.id = p_platform_user FOR SHARE;

  IF v_is_admin IS NOT TRUE THEN
    -- Two ordinary members cannot reach a cross-community match through this function, whichever
    -- argument position they are supplied in.
    RETURN pg_catalog.jsonb_build_object('outcome','ineligible','detail','not_platform_account');
  END IF;

  -- The member side must be a real, active member. The platform account is exempt from the
  -- COMMUNITY rule, not from existing.
  SELECT (p.account_status = 'active') INTO v_member_ok
  FROM public.profiles p WHERE p.id = p_member;
  IF v_member_ok IS NOT TRUE THEN
    RETURN pg_catalog.jsonb_build_object('outcome','ineligible','detail','member_unavailable');
  END IF;

  SELECT m.id INTO v_match_id
  FROM public.matches m
  WHERE (m.user_a_id = p_platform_user AND m.user_b_id = p_member)
     OR (m.user_a_id = p_member AND m.user_b_id = p_platform_user)
  LIMIT 1;

  IF v_match_id IS NOT NULL THEN
    SELECT c.id INTO v_conversation_id FROM public.conversations c WHERE c.match_id = v_match_id LIMIT 1;
    RETURN pg_catalog.jsonb_build_object(
      'outcome','already_matched','match_id', v_match_id, 'conversation_id', v_conversation_id);
  END IF;

  INSERT INTO public.matches
    (user_a_id, user_b_id, status, admin_facilitated, admin_notes, matched_at)
  VALUES
    (p_platform_user, p_member, 'active', true, p_admin_notes, pg_catalog.now())
  RETURNING id INTO v_match_id;

  INSERT INTO public.conversations (match_id) VALUES (v_match_id) RETURNING id INTO v_conversation_id;

  RETURN pg_catalog.jsonb_build_object(
    'outcome','created','match_id', v_match_id, 'conversation_id', v_conversation_id);
END
$$;

REVOKE ALL ON FUNCTION public.create_support_match(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_support_match(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.create_support_match(uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_support_match(uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION public.create_support_match(uuid, uuid, text) IS
  'The ONLY sanctioned cross-community relationship: platform-account <-> member, for the admin '
  'welcome and issue-reply support paths. Keyed on profiles.is_admin = TRUE (read FOR SHARE), never '
  'on ADMIN_EMAIL. Refuses unless the named platform participant really is the platform account, so '
  'two ordinary members cannot use it in any argument order. community_pair_allowed is NOT consulted '
  'and NOT weakened. service_role EXECUTE only. Migration 096.';


-- ── SECTION 4 — POSTAPPLY INTEGRITY PROOF ────────────────────────────────────────────────────
-- Restating a 400-line function to add four lines is exactly the operation where a truncated or
-- mis-sourced body ships unnoticed. This block re-reads pg_proc and proves, for every replaced
-- function: it exists under the SAME signature, is still SECURITY DEFINER with a pinned empty
-- search_path, still returns the SAME type, is still unreachable from anon/authenticated, now
-- contains community_pair_allowed, AND still contains distinctive markers from its ORIGINAL body.
-- The marker check is the one that catches accidental replacement: a truncated or wrong-function
-- body loses them. Any failure RAISEs and rolls the entire migration back.
DO $postcheck$
DECLARE
  r record;
  v_src text;
  v_secdef boolean;
  v_cfg text;
  v_ret text;
  m text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
    ('create_reciprocal_suggestion', 'public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer, uuid)', 'text', ARRAY['exists_active', 'member_pairs', 'p_release_id']),
    ('place_batch_rows', 'public.place_batch_rows(uuid, text, jsonb, uuid, integer)', 'jsonb', ARRAY['p_rows', 'admin_reciprocal', 'recommendation_batches']),
    ('promote_queued_rows', 'public.promote_queued_rows(uuid)', 'jsonb', ARRAY['deferred_capacity', 'empty_queued_batch']),
    ('materialize_admin_pair', 'public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer)', 'jsonb', ARRAY['proposal_not_symmetric', 'batch_suggestions', 'p_review_batch_id']),
    ('finalize_mutual_match_atomic', 'public.finalize_mutual_match_atomic(uuid, uuid, boolean)', 'jsonb', ARRAY['consume_credits_and_create_match', 'consent_missing']),
    ('consume_credits_and_create_match', 'public.consume_credits_and_create_match(uuid, uuid, boolean)', 'record', ARRAY['v_chargeable', 'insufficient_credits_a', 'credit_transactions'])
    ) AS t(fname, sig, rettype, markers)
  LOOP
    IF pg_catalog.to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION '096: % is missing after replacement (signature changed?).', r.sig;
    END IF;

    SELECT p.prosrc, p.prosecdef,
           COALESCE(pg_catalog.array_to_string(p.proconfig, ','), '(none)'),
           pg_catalog.format_type(p.prorettype, NULL)
      INTO v_src, v_secdef, v_cfg, v_ret
    FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure(r.sig);

    IF NOT v_secdef THEN
      RAISE EXCEPTION '096: % is no longer SECURITY DEFINER.', r.fname;
    END IF;
    IF v_cfg NOT IN ('search_path=', 'search_path=""') THEN
      RAISE EXCEPTION '096: % has a mutable search_path (%).', r.fname, v_cfg;
    END IF;
    IF v_ret <> r.rettype THEN
      RAISE EXCEPTION '096: % return type is %, expected %.', r.fname, v_ret, r.rettype;
    END IF;
    IF pg_catalog.strpos(v_src, 'community_pair_allowed') = 0 THEN
      RAISE EXCEPTION '096: % does not contain the community guard.', r.fname;
    END IF;
    FOREACH m IN ARRAY r.markers LOOP
      IF pg_catalog.strpos(v_src, m) = 0 THEN
        RAISE EXCEPTION '096: % lost original marker % — body was truncated or replaced.', r.fname, m;
      END IF;
    END LOOP;
    IF pg_catalog.has_function_privilege('anon', r.sig, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION '096: a browser role can EXECUTE %.', r.fname;
    END IF;
  END LOOP;

  -- The sealed delegate: migration 068 revoked EXECUTE from service_role too, leaving the definer
  -- wrapper as its only caller. CREATE OR REPLACE preserves privileges, so this asserts that.
  IF pg_catalog.has_function_privilege('service_role',
       'public.consume_credits_and_create_match(uuid, uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '096: consume_credits_and_create_match is no longer sealed from service_role.';
  END IF;

  -- The two new primitives.
  FOR r IN SELECT * FROM (VALUES
      ('public.create_gated_match(uuid, uuid, boolean, text, text, timestamptz, boolean, uuid, jsonb)'),
      ('public.create_support_match(uuid, uuid, text)')
    ) AS t(sig)
  LOOP
    IF pg_catalog.to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION '096: % was not created.', r.sig;
    END IF;
    IF pg_catalog.has_function_privilege('anon', r.sig, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION '096: a browser role can EXECUTE %.', r.sig;
    END IF;
    IF NOT pg_catalog.has_function_privilege('service_role', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION '096: service_role cannot EXECUTE %.', r.sig;
    END IF;
  END LOOP;

  -- community_pair_allowed must be untouched by this migration.
  IF pg_catalog.has_function_privilege('anon', 'public.community_pair_allowed(uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'public.community_pair_allowed(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '096: community_pair_allowed became browser-executable.';
  END IF;

  -- And 058's contract still holds.
  IF pg_catalog.has_table_privilege('anon', 'public.profiles', 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION '096: a browser role holds SELECT on public.profiles.';
  END IF;
END
$postcheck$;

COMMIT;
