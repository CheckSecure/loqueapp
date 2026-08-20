-- 066_expire_intro_pair.sql
--
-- ATOMIC EXPIRY OF ONE UNANSWERED INTRODUCTION PAIR.
--
-- NOT YET APPLIED. Operator applies in the Supabase Dashboard after review.
-- Migrations 063 and 064 are applied and are NOT modified by this file.
--
-- ─── WHY AN RPC AND NOT A CLIENT LOOP ────────────────────────────────────────────────────────────
-- A reciprocal pair is two directional rows. Expiring them from the application would be two
-- statements in two round trips — precisely the shape that produced 145 one-sided rows when admin
-- approval placed cards one recipient at a time. Half an expired pair is worse than none: one member
-- regains a slot and loses the card while the other still sees it. Both rows move together here, in
-- one transaction, under both members' advisory locks, or neither moves.
--
-- ─── HOW A RECIPROCAL PAIR REPRESENTS EACH STATE ─────────────────────────────────────────────────
-- A pair is exactly two directional intro_requests rows sharing one pair_id:
--   A->B 'suggested'  + B->A 'suggested'   neither has responded
--   A->B 'approved'   + B->A 'suggested'   A ONLY — private, B has not seen it
--   A->B 'suggested'  + B->A 'approved'    B ONLY — private, A has not seen it
--   A->B 'approved'   + B->A 'approved'    MUTUAL — finalizeMutualMatch runs and creates the match
--   finalized                              a public.matches row exists; member_pairs.status='matched'
-- 'accepted' behaves as 'approved' (ACTING_CONSENT_STATUSES) and a legacy member-initiated 'pending'
-- counts as counterpart interest (COUNTERPART_INTEREST_STATUSES), so both are treated as interest.
--
-- ─── THE CORRECTION: ONE-SIDED INTEREST MUST NOT BLOCK CAPACITY FOREVER ──────────────────────────
-- An earlier draft refused expiry whenever EITHER member had expressed interest. That was wrong and
-- it recreated the exact stale-capacity problem this work exists to end: A expresses private
-- interest, B never responds, and B's 'suggested' card is then unexpirable — B's slot is occupied
-- indefinitely by a decision B never made and cannot see.
--
-- The refusal is now precise:
--   CASE A  both directions still 'suggested'            -> expire BOTH.
--   CASE B  exactly ONE direction is private interest and
--           the other is still unanswered 'suggested'    -> close BOTH, privacy-neutrally.
--   MUTUAL  BOTH directions are interest                 -> REFUSE ('mutual_pending'). Finalization
--                                                           owns this pair; expiry never pre-empts it.
--   FINAL   a matches row, or member_pairs 'matched'/'blocked' -> REFUSE. Never touched.
--
-- Case B closes both rows as 'expired' — a status the CHECK constraint already allows and that the
-- UI already renders neutrally. It is deliberately NOT a new or overloaded status: 'expired' is
-- truthful for both sides (the introduction timed out) and says nothing about who acted. No
-- resolution_reason is written, because migration 062 constrains it to
-- ('not_for_me','never_show','already_know') and none of those is true here.
--
-- Neither member is told anything: this function writes no notification and sends no email, so A
-- cannot learn that B never answered and B can never learn that A was interested. No match,
-- conversation, credit event or connection is created.
--
-- SCOPE. Only rows carrying THIS pair_id are touched. A standalone legacy 'pending' workflow has no
-- pair_id and is therefore untouched by this function — the blanket "never expire a pending row"
-- rule survives exactly where it belongs.
--
-- ─── RACE WITH MUTUAL FINALIZATION, IN BOTH ORDERINGS ────────────────────────────────────────────
-- Both members' advisory locks are taken in canonical order and ALL state is re-read inside the
-- transaction, so the two paths serialise on the same keys as placement and promotion.
--   FINALIZATION FIRST -> it creates the matches row and sets member_pairs.status='matched'; expiry
--     then re-reads, sees both, and refuses. The match is never overwritten.
--   EXPIRY FIRST -> both rows become 'expired'. A later finalization calls bothMembersConsented,
--     which requires ACTING_CONSENT_STATUSES / COUNTERPART_INTEREST_STATUSES; 'expired' is in
--     neither, so it returns 409 and CANNOT resurrect the pair. That guard already exists in
--     lib/introductions/finalizeMutualMatch.ts and is relied on here rather than duplicated.
--
-- ─── WHAT IS PRESERVED ───────────────────────────────────────────────────────────────────────────
-- last_recommended_at and recommend_count are NOT reset, so the 30-day pair cooldown still bars an
-- immediate re-pairing. member_pairs.status becomes 'expired', which is already in the CHECK
-- constraint from migration 050. Nothing is deleted; the rows remain as history with expired_at set.
--
-- Capacity is released as a consequence, not as an action: capacity counts status='suggested', and
-- these rows are no longer 'suggested'.
--
-- ─── NO NOTIFICATION ─────────────────────────────────────────────────────────────────────────────
-- This function sends nothing and writes to no notification table. Neither member learns that the
-- other did or did not respond. Emails are the caller's business and are not done in SQL.

CREATE OR REPLACE FUNCTION public.expire_intro_pair(
  p_pair_id     uuid,
  p_max_age_days integer DEFAULT 14
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now    timestamptz := pg_catalog.now();
  v_cutoff timestamptz := pg_catalog.now()
                          - pg_catalog.make_interval(days => GREATEST(COALESCE(p_max_age_days, 14), 0));
  lo uuid; hi uuid;
  v_pair   record;
  v_n_open integer;   -- rows still 'suggested'
  v_n_old  integer;   -- of those, how many are old enough
  v_int_lo integer;   -- lo expressed interest (approved/accepted/pending)
  v_int_hi integer;   -- hi expressed interest
  v_n_rows integer;
  v_case   text;
BEGIN
  IF p_pair_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','missing_pair_id');
  END IF;

  -- Read the canonical pair WITHOUT locking members yet, only to learn who they are.
  SELECT mp.id, mp.user_a_id, mp.user_b_id, mp.status
    INTO v_pair
  FROM public.member_pairs mp WHERE mp.id = p_pair_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','pair_not_found');
  END IF;

  lo := LEAST(v_pair.user_a_id, v_pair.user_b_id);
  hi := GREATEST(v_pair.user_a_id, v_pair.user_b_id);

  -- Canonical lock order, same key space as migrations 050/063/064, so this serialises against
  -- placement, promotion and admin materialisation for the same members.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lo::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text, 0));

  -- Re-read the pair under the lock; it may have finalized while we waited.
  SELECT mp.id, mp.status INTO v_pair
  FROM public.member_pairs mp WHERE mp.id = p_pair_id FOR UPDATE;
  IF v_pair.status IN ('matched','blocked') THEN
    RETURN pg_catalog.jsonb_build_object('outcome','protected','detail','pair_terminal');
  END IF;

  -- A finalized connection is never expired.
  IF EXISTS (
    SELECT 1 FROM public.matches m
    WHERE (m.user_a_id = lo AND m.user_b_id = hi) OR (m.user_a_id = hi AND m.user_b_id = lo)
  ) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','protected','detail','match_exists');
  END IF;

  -- Classify the pair from its two directional rows, re-read under the lock.
  SELECT
    count(*) FILTER (WHERE ir.status = 'suggested'),
    count(*) FILTER (WHERE ir.status = 'suggested' AND ir.created_at < v_cutoff),
    count(*) FILTER (WHERE ir.requester_id = lo AND ir.status IN ('approved','accepted','pending')),
    count(*) FILTER (WHERE ir.requester_id = hi AND ir.status IN ('approved','accepted','pending')),
    count(*)
    INTO v_n_open, v_n_old, v_int_lo, v_int_hi, v_n_rows
  FROM public.intro_requests ir
  WHERE ir.pair_id = p_pair_id;

  -- MUTUAL: both sides expressed interest. Finalization owns this pair; expiry must never pre-empt
  -- it, and a mutual response that wins the race therefore finalizes normally.
  IF v_int_lo > 0 AND v_int_hi > 0 THEN
    RETURN pg_catalog.jsonb_build_object('outcome','protected','detail','mutual_pending');
  END IF;

  -- Nothing left to close (already expired, passed, or archived) — idempotent no-op.
  IF v_n_open = 0 AND v_int_lo = 0 AND v_int_hi = 0 THEN
    RETURN pg_catalog.jsonb_build_object('outcome','skipped','detail','nothing_open');
  END IF;

  -- CASE A: neither responded. Both must be open and both old enough.
  -- CASE B: exactly one side is private interest and the other is still unanswered 'suggested'.
  IF v_int_lo = 0 AND v_int_hi = 0 THEN
    IF v_n_open <> 2 THEN
      RETURN pg_catalog.jsonb_build_object('outcome','skipped','detail','not_two_open_rows');
    END IF;
    IF v_n_old <> 2 THEN
      RETURN pg_catalog.jsonb_build_object('outcome','skipped','detail','not_old_enough');
    END IF;
    v_case := 'both_unanswered';
  ELSE
    -- One-sided interest. The UNANSWERED side must still be open and old enough; the interested
    -- side is closed with it so neither row survives to occupy capacity or to leak asymmetry.
    IF v_n_open <> 1 THEN
      RETURN pg_catalog.jsonb_build_object('outcome','skipped','detail','unanswered_side_not_open');
    END IF;
    IF v_n_old <> 1 THEN
      RETURN pg_catalog.jsonb_build_object('outcome','skipped','detail','not_old_enough');
    END IF;
    v_case := 'one_sided_interest';
  END IF;

  ------------------------------------------------------------------ FIRST WRITE
  -- Everything above is read-only, so every refusal leaves the database untouched.
  -- Close EVERY still-live row of this pair in one statement. In case B that includes the
  -- interested side, so both directions stop consuming visible and pending capacity together and
  -- neither member is left holding a row the other cannot see.
  UPDATE public.intro_requests
  SET status = 'expired', expired_at = v_now, updated_at = v_now
  WHERE pair_id = p_pair_id
    AND status IN ('suggested','approved','accepted','pending');

  -- History and cooldown are PRESERVED: last_recommended_at and recommend_count are untouched, so
  -- the 30-day pair cooldown still bars an immediate re-pairing.
  UPDATE public.member_pairs
  SET status = 'expired'
  WHERE id = p_pair_id;

  RETURN pg_catalog.jsonb_build_object(
    'outcome','expired', 'case', v_case, 'pair_id', p_pair_id);
END;
$$;

REVOKE ALL ON FUNCTION public.expire_intro_pair(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_intro_pair(uuid, integer) TO service_role;
