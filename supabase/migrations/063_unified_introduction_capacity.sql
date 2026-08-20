-- 063_unified_introduction_capacity.sql
--
-- NOT YET APPLIED. The operator applies this in the Supabase Dashboard after review.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHAT WAS WRONG (established from production evidence, read-only)
--
-- A member's introduction capacity was decided in three places that did not agree:
--
--   1. create_reciprocal_suggestion (migration 050) counted 'suggested' + 'queued' TOGETHER against
--      one cap of 2.
--   2. The queue service decided ACTIVE vs QUEUED placement from the EXISTENCE of a
--      recommendation_batches row, and never counted intro_requests at all.
--   3. The introductions page ordered by created_at DESC and sliced to 2 for display.
--
-- Reciprocal pair cards are created with batch_id NULL on purpose (050 step 8), so a member holding
-- only reciprocal cards had NO batch row. enqueueBatch's `if (!active)` branch therefore inserted a
-- fresh batch directly as VISIBLE on top of them. All four production over-capacity members show
-- exactly this: one onboarding reciprocal card (batch_id NULL), then two admin_reciprocal rows with
-- created_at = updated_at and a batch whose displayed_at = created_at and completed_at IS NULL —
-- inserted straight as 'suggested', never promoted. Because the slice keeps the NEWEST two, the
-- hidden row is the reciprocal card, on BOTH sides of the pair.
--
-- A SECOND, INDEPENDENT MECHANISM exists and is closed here too, though it did not produce those
-- rows: promoteIfResolved archived only rows matching batch_id, so a resolved reciprocal card
-- survived as 'suggested' and still occupied a visible slot while the entire queued batch was
-- revealed on top of it.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE CONTRACT THIS MIGRATION ENFORCES
--
-- TWO independent tiers, never one combined cap:
--
--   VISIBLE  (status 'suggested')  at most 2
--   RESERVED (status 'queued')     at most 2
--
--   • Capacity is decided by `status` ALONE. Whether batch_id or pair_id is populated is
--     irrelevant: a reciprocal card and a legacy batch card consume the same slot.
--   • A reserved card does NOT block a visible one. A member with 0 visible and 2 queued may still
--     receive a reciprocal introduction into a visible slot.
--   • Placement and promotion may fill only slots that are actually free, and TRUNCATE rather than
--     overflow. Nothing is ever evicted.
--
-- THE LIMITS ARE FIXED IN THE DATABASE. The new functions take NO capacity argument at all, and
-- create_reciprocal_suggestion (whose signature must be preserved for the existing caller) CLAMPS
-- its p_max_cards downward against the internal constant, so no caller — including a compromised or
-- buggy service-role caller passing 100 — can raise either cap. A caller may only ever be more
-- conservative than the database, never less.
--
-- SERIALIZATION. Every capacity decision for a member is taken while holding
-- pg_advisory_xact_lock(hashtextextended(member_id::text, 0)) — the SAME key space migration 050
-- already uses — so a reciprocal creation and a batch placement for the same member cannot both
-- observe "one slot free" and both fill it. create_reciprocal_suggestion takes the two participant
-- locks in canonical order (lo, hi); the single-member functions take exactly one. A single-lock
-- holder cannot form a cycle with a canonical-order two-lock holder, so no deadlock is possible.
--
-- Counting happens AFTER the lock is acquired, never before.
--
-- NO PARTIAL WRITES ON REFUSAL. In place_batch_rows every validation, count and decision completes
-- before the first write; the writes are contiguous at the end. A refusal therefore cannot leave a
-- discarded batch, an empty batch, or a half-placed batch behind.
--
-- IDEMPOTENT: CREATE OR REPLACE only; applying this file modifies no rows. Existing over-capacity
-- rows are NOT corrected here — that is a separate, reviewed cleanup.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────


-- ══ 1. create_reciprocal_suggestion — VISIBLE-only capacity, caller-proof cap ════════════════════
--
-- Changes from migration 050, and nothing else:
--   (a) step 5 counts status = 'suggested' instead of status IN ('suggested','queued');
--   (b) p_max_cards >= 1 is clamped to the internal constant and can no longer raise the cap;
--   (c) p_max_cards NULL, 0 or negative now returns 'invalid' before any lock or write, instead of
--       being coalesced up to the full cap.
-- Every other step — eligibility, blocking, match history, live-intro/cooldown exclusion, canonical
-- pair claim + FOR UPDATE, the pair cooldown, the atomic two-row insert, the member_pairs update,
-- the advisory locks and every return value — is reproduced verbatim so this file is the complete,
-- readable definition of the function rather than a diff.

CREATE OR REPLACE FUNCTION public.create_reciprocal_suggestion(
  a_id uuid,
  b_id uuid,
  p_source text DEFAULT 'reciprocal',
  p_reason text DEFAULT NULL,          -- genuine fit reason (or NULL); NOT the label
  p_cooldown_days integer DEFAULT 30,
  p_max_cards integer DEFAULT 2        -- >=1 is clamped to c_max_visible; NULL/<=0 -> 'invalid'
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
    WHERE ir.requester_id = a_id AND ir.status = 'suggested';
  SELECT count(*) INTO b_cards FROM public.intro_requests ir
    WHERE ir.requester_id = b_id AND ir.status = 'suggested';
  IF a_cards >= max_cards OR b_cards >= max_cards THEN
    RETURN 'capacity';
  END IF;

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
  INSERT INTO public.intro_requests
    (requester_id, target_user_id, status, is_admin_initiated, match_reason, pair_id, created_at, updated_at)
  VALUES
    (a_id, b_id, 'suggested', false, p_reason, pair.id, now(), now()),
    (b_id, a_id, 'suggested', false, p_reason, pair.id, now(), now());

  UPDATE public.member_pairs
  SET recommend_count = recommend_count + 1,
      last_recommended_at = now(),
      first_recommended_at = coalesce(first_recommended_at, now()),
      status = 'active'
  WHERE id = pair.id;

  RETURN 'created';
END;
$$;

REVOKE ALL ON FUNCTION public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer) TO service_role;


-- ══ 2. place_batch_rows — the ONE transactional placement path ═══════════════════════════════════
--
-- Replaces the application-side enqueueBatch sequence (dedupe → read batch slots → insert) with a
-- single locked transaction that counts intro_requests instead of batch rows.
--
-- NO CAPACITY ARGUMENT. The caps are constants below. There is no parameter a caller can use to
-- raise them.
--
-- ─── THE TWO-TIER ALGORITHM ──────────────────────────────────────────────────────────────────────
--
-- ONE call uses ALL safely available capacity, in tier order:
--
--   1. visible_free  = c_max_visible  − count(status='suggested')
--   2. reserved_free = c_max_reserved − count(status='queued')
--   3. take_visible  = min(visible_free,  |candidates|)                 -- fill the screen first
--   4. take_reserved = min(reserved_free, |candidates| − take_visible)  -- then reserve
--   5. dropped       = |supplied| − take_visible − take_reserved        -- beyond BOTH limits only
--
--   1 suggested / 0 queued + 2 candidates  →  1 suggested + 1 queued
--   0 suggested / 0 queued + 4 candidates  →  2 suggested + 2 queued
--   2 suggested / 1 queued + 2 candidates  →  0 suggested + 1 queued + 1 dropped
--
-- Both tiers are written in the SAME transaction under the SAME per-member advisory lock, so the
-- pair of writes is atomic and cannot interleave with a concurrent reciprocal creation.
--
-- ─── BATCH METADATA, WITHOUT WEAKENING THE INDEXES ───────────────────────────────────────────────
--
-- recommendation_batches keeps its two partial-unique indexes (one active, one queued per member)
-- untouched. A call therefore either APPENDS to the member's existing batch of that state or CREATES
-- the batch when none exists — it never creates a second one.
--
-- PROVENANCE GUARD. Appending is allowed only when the existing batch's batch_source EQUALS
-- p_source. Mixing an admin_reciprocal row into a weekly batch (or the reverse) would make
-- batch_source a lie, and batch_source drives notification and reporting decisions. On a mismatch
-- that TIER is skipped — the batch is left exactly as it is and the call continues with the other
-- tier. It never merges and it never evicts.
--
-- ─── NOTHING IS EVER EVICTED ─────────────────────────────────────────────────────────────────────
--
-- There is no DELETE and no discard in this function, for any source. An admin batch has no
-- precedence over capacity: if the reserved tier is full, the call returns 'reserved_full' and every
-- existing row and every batch row is left byte-for-byte unchanged. The previous implementation
-- deleted an organic queued batch to make room for an admin one; that behaviour is gone.
--
-- ─── ELIGIBILITY IS RE-CHECKED HERE, NOT TRUSTED FROM THE CALLER ─────────────────────────────────
--
-- A service-role caller is not a trusted source of safe targets. Every candidate must independently
-- satisfy the same gates create_reciprocal_suggestion applies: the target exists and is eligible,
-- is not blocked in either direction, is not already matched, has no live/committed intro in either
-- direction, and is not inside the soft-dismissal cooldown. The MEMBER's own eligibility is checked
-- first; an ineligible member gets nothing. Because targets are filtered through public.profiles, a
-- non-existent id cannot reach the INSERT and cannot raise a foreign-key exception.
--
-- ─── INPUT HANDLING (all fail closed, all before any write) ──────────────────────────────────────
--   • p_member_id NULL / member missing or ineligible  → 'invalid' / 'ineligible'
--   • p_source not one of the four sources             → 'invalid'
--   • p_rows not a JSON array                          → 'invalid'
--   • p_rows longer than c_max_rows (50)               → 'too_many_rows'
--   • element without a syntactically valid uuid       → skipped, counted in `dropped`
--   • target equal to the member (self-pair)           → skipped
--   • duplicate targets within the payload             → deterministically deduplicated, FIRST
--                                                        occurrence wins, so the ranker's order is
--                                                        preserved end to end
--   • target failing any eligibility/history gate      → skipped
--   • more than one active or queued batch             → 'inconsistent_batches' (the partial unique
--                                                        indexes forbid it; asserted, never acted on)
--
-- Returns jsonb, containing NO member identifiers, NO target identifiers and NO raw payload:
--   {placed, visible_placed, reserved_placed, dropped, active_batch_id, queued_batch_id, reason}

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
  SELECT count(*) FILTER (WHERE ir.status = 'suggested'),
         count(*) FILTER (WHERE ir.status = 'queued')
    INTO v_visible, v_reserved
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

  v_visible_free  := GREATEST(0, c_max_visible  - v_visible);
  v_reserved_free := GREATEST(0, c_max_reserved - v_reserved);

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

REVOKE ALL ON FUNCTION public.place_batch_rows(uuid, text, jsonb, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_batch_rows(uuid, text, jsonb, uuid, integer) TO service_role;


-- ══ 3. promote_queued_rows — reveal reservations into FREE visible slots only ════════════════════
--
-- Replaces the application-side promoteIfResolved sequence. NO CAPACITY ARGUMENT.
--
-- ─── BATCH COMPLETION IS SCOPED TO THE BATCH ─────────────────────────────────────────────────────
--
-- "Is this batch finished?" is asked ONLY of that batch's own rows. A reciprocal card lives outside
-- every batch (batch_id NULL, pair-governed), so an unanswered reciprocal card must NOT keep an
-- otherwise-finished legacy batch pinned to 'active' forever. It does still consume a VISIBLE slot,
-- which correctly reduces how many reservations can be revealed — capacity and batch lifecycle are
-- different questions and are now answered separately.
--
-- (The application's countUnresolvedRecommendations deliberately keeps the WIDER definition — "does
-- this member have any live work at all" — because weekly-generation eligibility is a different
-- question again. The two are not meant to match.)
--
-- ─── WHAT PROMOTION MAY DO ───────────────────────────────────────────────────────────────────────
--
--   • It re-counts VISIBLE cards AFTER completing the active batch, so surviving reciprocal cards
--     are counted and only genuinely free slots are filled.
--   • When only SOME of the queued batch fits, it promotes what fits and SPLITS the remainder into a
--     fresh queued batch, so every batch's rows share its state and both partial-unique indexes stay
--     satisfied. Order matters: the old batch is flipped to 'active' BEFORE the new queued batch is
--     inserted, so there is never a moment with two active or two queued batches.
--   • It no longer requires an active batch to exist, so a reservation deferred earlier for want of
--     a free slot is promoted on a later call. Self-healing, and safe to call after every action.
--   • It never deletes, evicts or discards anything.
--
-- ON WRITES BEFORE A NON-PROMOTING RETURN. Completing a fully-resolved active batch, and closing a
-- queued batch that holds no queued rows, are correct state transitions in their own right — not
-- partial work toward a promotion that then failed. They are committed even when the function goes
-- on to report 'deferred_capacity' or 'empty_queued_batch'. Nothing is discarded in either case.
--
-- Returns jsonb, containing NO member identifiers:
--   {promoted, active_completed, new_active, split_batch, count, reason}

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

  -- (1) Re-count VISIBLE after completion. Pair-governed reciprocal cards survive it and count.
  SELECT count(*) INTO v_visible FROM public.intro_requests ir
    WHERE ir.requester_id = p_member_id AND ir.status = 'suggested';
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

REVOKE ALL ON FUNCTION public.promote_queued_rows(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_queued_rows(uuid) TO service_role;


-- ── Verification (read-only; run after applying) ─────────────────────────────────────────────────
-- 1. All three functions exist, are SECURITY DEFINER, and pin search_path:
--      SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner
--      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--      WHERE n.nspname = 'public'
--        AND p.proname IN ('create_reciprocal_suggestion','place_batch_rows','promote_queued_rows');
--
-- 2. Only service_role may execute them:
--      SELECT p.proname,
--             has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon,
--             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
--             has_function_privilege('service_role',  p.oid, 'EXECUTE') AS service_role
--      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--      WHERE n.nspname = 'public'
--        AND p.proname IN ('create_reciprocal_suggestion','place_batch_rows','promote_queued_rows');
--
-- 3. The caps cannot be raised by a caller:
--      SELECT public.create_reciprocal_suggestion(
--        '<member-at-visible-cap>'::uuid, '<any-other-member>'::uuid, 'reciprocal', NULL, 30, 100);
--    Expect 'capacity'.
--
-- 4. Standing invariants (each must return ZERO rows):
--      SELECT requester_id FROM public.intro_requests WHERE status='suggested'
--        GROUP BY 1 HAVING count(*) > 2;
--      SELECT requester_id FROM public.intro_requests WHERE status='queued'
--        GROUP BY 1 HAVING count(*) > 2;
--      SELECT member_id FROM public.recommendation_batches WHERE state='active'
--        GROUP BY 1 HAVING count(*) > 1;
--      SELECT member_id FROM public.recommendation_batches WHERE state='queued'
--        GROUP BY 1 HAVING count(*) > 1;
--      SELECT b.batch_id FROM public.recommendation_batches b
--        JOIN public.intro_requests i ON i.batch_id = b.batch_id
--       WHERE (b.state='active' AND i.status='queued')
--          OR (b.state='queued' AND i.status='suggested');
