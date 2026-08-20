-- 067_finalize_mutual_match_atomic.sql
--
-- CLOSES THE EXPIRATION-VERSUS-FINALIZATION TOCTOU WINDOW.
--
-- NOT YET APPLIED. Operator applies in the Supabase Dashboard after review.
-- Migrations 063 and 064 are applied and are NOT modified by this file. Migration 066 is unchanged.
--
-- ─── THE UNSAFE INTERLEAVING THIS EXISTS TO END ──────────────────────────────────────────────────
-- lib/introductions/finalizeMutualMatch.ts validates consent with bothMembersConsented() in ONE
-- round trip and then calls public.consume_credits_and_create_match in ANOTHER. Those are two
-- separate database transactions, so an expiration can land between them:
--
--   1. both directional rows are in consent states
--   2. finalization SELECTs them and concludes both members consented          <-- read
--   3. public.expire_intro_pair takes the member locks and sets both to 'expired'
--   4. finalization proceeds on its now-stale result                           <-- stale
--   5. consume_credits_and_create_match creates a match, a conversation, and charges BOTH members
--      for an introduction that no longer exists
--
-- An application-level precheck can never close this: it is authorization computed outside the
-- transaction that acts on it. The check must live inside the transaction that writes.
--
-- ─── WHY A GUARDED WRAPPER, NOT A PARALLEL WRITER ────────────────────────────────────────────────
-- public.consume_credits_and_create_match remains the ONE writer of matches, conversations and
-- credits. This function does not reimplement any of it — it takes the same member advisory locks
-- migration 066 uses, revalidates consent under those locks, and only then DELEGATES, all inside a
-- single transaction. A second match writer would be a new class of bug; a guard in front of the
-- existing one is not.
--
-- Advisory locks are re-entrant within a transaction, so if the delegate already takes the same
-- keys, taking them here first is harmless.
--
-- ─── THE SHARED PROTOCOL ─────────────────────────────────────────────────────────────────────────
-- Expiration (066) and finalization (067) now agree on all three points:
--   * the same two keys: pg_advisory_xact_lock(hashtextextended(member_id::text, 0))
--   * the same canonical order: LEAST(...) then GREATEST(...)
--   * revalidation AFTER the locks, INSIDE the transaction that writes
-- Exactly one can win:
--   FINALIZATION FIRST -> it commits the match; expiry re-reads, sees the matches row and the
--     'matched' pair, and refuses. Nothing is overwritten.
--   EXPIRY FIRST -> both rows become 'expired'; 'expired' is in neither consent set, so the
--     revalidation below fails and NO match, conversation, credit or notification is produced.
--
-- ─── CONSENT IS NEVER MANUFACTURED ───────────────────────────────────────────────────────────────
-- The ACTING member's own row must be 'approved' or 'accepted' (ACTING_CONSENT_STATUSES). The
-- COUNTERPART's row must be 'approved', 'accepted' or a legacy member-initiated 'pending'
-- (COUNTERPART_INTEREST_STATUSES). 'admin_pending' and 'suggested' appear in neither, so an admin
-- action can never satisfy this — exactly as lib/introRequests/classify.ts specifies.
--
-- ─── NOTIFICATIONS ───────────────────────────────────────────────────────────────────────────────
-- This function emits none. The caller sends mutual-interest notifications ONLY after it returns
-- outcome='finalized', so a notification can never precede a committed match.

-- ==============================================================================================
-- PART 1 OF 2 - BRING THE OUT-OF-BAND DELEGATE INTO THE REPOSITORY, HARDENED
--
-- public.consume_credits_and_create_match was created OUT OF BAND, directly in the Supabase
-- dashboard. It appeared in NO migration in this repository. It is SECURITY DEFINER, owned by
-- postgres, VOLATILE, and it was found EXECUTABLE BY PUBLIC / anon / authenticated - meaning any
-- browser session could charge two members a credit and manufacture a match and a conversation,
-- with no consent check whatsoever. That was contained out of band; production now reports
-- PUBLIC / anon / authenticated cannot execute and service_role can. This migration makes the
-- object permanent, reviewable and version-controlled instead of dashboard-resident.
--
-- SOURCE OF TRUTH: the operator's pg_get_functiondef() output for
-- public.consume_credits_and_create_match(uuid, uuid, boolean). The body below is that definition.
--
-- --- WHAT IS PRESERVED EXACTLY -----------------------------------------------------------------
-- signature and argument defaults; RETURNS TABLE(match_id, conversation_id, error_code) in that
-- order; LANGUAGE plpgsql; VOLATILE; SECURITY DEFINER; the deduction from A; the deduction from B;
-- the balance recalculation; insufficient_credits_a; the subtransaction rollback of A's deduction
-- on B failure with insufficient_credits_b; the subtransaction rollback of BOTH deductions on a
-- duplicate match with duplicate_match; match creation; conversation creation; admin_facilitated;
-- and the observable return behaviour in every branch.
--
-- Note the balance expression, which is copied verbatim and must not be "simplified":
--     balance = (free_credits - 1) + COALESCE(premium_credits, 0)
-- In an UPDATE SET list the right-hand side reads the OLD column values, so this recomputes balance
-- from the pre-update free_credits. It is NOT the same as `balance = balance - 1`: it re-derives the
-- invariant balance = free_credits + premium_credits that migration 052 maintains, and therefore
-- also repairs a row whose balance had drifted. Rewriting it would change observable behaviour.
--
-- --- WHAT IS HARDENED, AND NOTHING ELSE --------------------------------------------------------
--   1. SET search_path = ''. The audited body referenced meeting_credits, matches and conversations
--      UNQUALIFIED with no configured search_path, so the CALLER controlled name resolution - a
--      SECURITY DEFINER function owned by postgres could be pointed at attacker-supplied tables.
--   2. Every non-built-in reference is now schema-qualified: public.meeting_credits, public.matches,
--      public.conversations. Built-in PL/pgSQL constructs and pg_catalog functions (COALESCE, the
--      unique_violation condition name, SQLERRM) are untouched - pg_catalog is always implicitly
--      searched, so an empty search_path does not affect them.
--   3. EXECUTE revoked from PUBLIC, anon and authenticated.
--
-- CREDIT POLICY IS UNCHANGED ON PURPOSE. The function charges the FREE pool only: `free_credits >= 1`
-- gates the deduction, so a member holding only premium credits is refused with
-- insufficient_credits_a/_b even though their balance is positive. That is the audited production
-- behaviour and it is preserved verbatim. Whether purchased credits SHOULD be spendable on an
-- introduction is a product and accounting decision, not a security fix, and changing it here would
-- silently alter who can be matched and how credits are consumed. Recorded as a separate follow-up.
--
-- --- WHAT IS DELIBERATELY NOT ADDED ------------------------------------------------------------
-- The audited body inserts (p_user_a, p_user_b) in the order given; it does not canonicalise the
-- pair, so the UNIQUE (user_a_id, user_b_id) constraint only raises unique_violation for a repeat in
-- the SAME order. Adding LEAST/GREATEST here would be a behaviour change, not a transcription. The
-- reversed-order case is handled one level up: finalize_mutual_match_atomic takes canonical advisory
-- locks and checks for an existing match in BOTH directions before it ever calls this function.
--
-- --- NO PRIVILEGE WINDOW -----------------------------------------------------------------------
-- One transaction. CREATE OR REPLACE FUNCTION preserves the existing ACL rather than re-granting to
-- PUBLIC (only CREATE of a NEW function grants EXECUTE to PUBLIC by default) - but this migration
-- does not rely on that: the REVOKEs are restated unconditionally, in the same transaction as the
-- replacement, so browser roles cannot hold EXECUTE at any instant during or after it.
-- ==============================================================================================

BEGIN;

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
BEGIN
  -- Subtransaction. Anything raised inside it discards every write made inside it, which is what
  -- makes the rollback of an already-applied deduction real rather than aspirational.
  BEGIN
    UPDATE public.meeting_credits
    SET free_credits = free_credits - 1,
        balance = (free_credits - 1) + COALESCE(premium_credits, 0)
    WHERE user_id = p_user_a AND free_credits >= 1;

    -- Nothing has been written yet, so there is nothing to unwind here.
    IF NOT FOUND THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'insufficient_credits_a'::text;
      RETURN;
    END IF;

    UPDATE public.meeting_credits
    SET free_credits = free_credits - 1,
        balance = (free_credits - 1) + COALESCE(premium_credits, 0)
    WHERE user_id = p_user_b AND free_credits >= 1;

    -- A HAS been charged by this point. Raising is what unwinds that charge.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'insufficient_credits_b' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.matches (user_a_id, user_b_id, admin_facilitated)
    VALUES (p_user_a, p_user_b, p_admin_facilitated)
    RETURNING id INTO v_match_id;

    INSERT INTO public.conversations (match_id)
    VALUES (v_match_id)
    RETURNING id INTO v_conversation_id;
  EXCEPTION
    -- Both deductions are unwound together with the rejected insert.
    WHEN unique_violation THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'duplicate_match'::text;
      RETURN;
    -- The only RAISE inside the block above is the B-side shortfall; SQLERRM carries its text.
    WHEN raise_exception THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, SQLERRM::text;
      RETURN;
  END;

  RETURN QUERY SELECT v_match_id, v_conversation_id, NULL::text;
END;
$function$;

-- Restate the containment explicitly. Never rely on a default, or on an out-of-band fix persisting.
REVOKE ALL ON FUNCTION public.consume_credits_and_create_match(uuid, uuid, boolean)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_credits_and_create_match(uuid, uuid, boolean)
  FROM anon, authenticated;

-- service_role KEEPS execute for now, and only for now: the currently deployed application
-- (commit 0823612) calls this function directly with the service-role key, from
-- lib/introductions/finalizeMutualMatch.ts and app/actions.ts. Revoking here would break mutual
-- finalization from the instant this migration is applied until the new build is Ready.
-- Migration 068 removes it as the final step of the rollout - see that file.
GRANT EXECUTE ON FUNCTION public.consume_credits_and_create_match(uuid, uuid, boolean)
  TO service_role;

COMMENT ON FUNCTION public.consume_credits_and_create_match(uuid, uuid, boolean) IS
  'Canonical match/conversation/credit writer. Created OUT OF BAND in the Supabase dashboard and absent from every migration until 067. Found EXECUTABLE BY PUBLIC/anon/authenticated, i.e. any browser session could charge two members and manufacture a match with no consent check; contained out of band, then transcribed from pg_get_functiondef into 067 with search_path pinned empty and every reference schema-qualified. Behaviour is otherwise unchanged, including the FREE-credit-only spend policy. Callers must go through public.finalize_mutual_match_atomic, which revalidates consent under the canonical member advisory locks.';

COMMIT;

-- ==============================================================================================
-- PART 2 OF 2 - THE ATOMIC CONSENT GUARD
-- ==============================================================================================

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

REVOKE ALL ON FUNCTION public.finalize_mutual_match_atomic(uuid, uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_mutual_match_atomic(uuid, uuid, boolean)
  TO service_role;
