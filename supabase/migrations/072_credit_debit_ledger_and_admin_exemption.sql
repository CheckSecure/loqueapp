-- ==============================================================================================
-- 072 - ONE ATOMIC AUTHORITY FOR CHARGEABILITY, DEBITS AND MATCH CREATION
--
-- NOT YET APPLIED. Review artifact.
--
-- ── THE TWO DEFECTS THIS CLOSES ────────────────────────────────────────────────────────────────
--
-- (1) NO ATTRIBUTABLE EVENT. public.consume_credits_and_create_match decrements free_credits and
--     recomputes balance, and writes NOTHING to any ledger. Every charge it has ever made is
--     invisible: there is no row anywhere saying who was debited, for what, or when. The only code
--     that writes a debit row is app/api/admin/facilitate-intro, a different path entirely. That is
--     why a member can lose a credit with no record of it existing.
--
-- (2) THE PLATFORM ADMINISTRATOR IS CHARGED. Nothing in the finalization path exempts anyone. When
--     a pair involving the administrator finalizes, the administrator is debited exactly like a
--     member, for a connection that is part of running the platform rather than a purchase.
--
-- ── WHAT THE EXEMPTION IS, AND WHAT IT IS NOT ──────────────────────────────────────────────────
--
-- The exemption keys on WHO THE PARTICIPANTS ARE, read from locked production rows:
--
--     chargeable  :=  NOT (profiles[a].is_admin  OR  profiles[b].is_admin)
--
-- It deliberately does NOT key on p_admin_facilitated. That flag means "an administrator arranged
-- this introduction", which is a perfectly ordinary thing to do FOR TWO ORDINARY MEMBERS - and
-- those two members must still be charged. Treating the flag as an exemption would hand every
-- caller a free-match switch: passing p_admin_facilitated => true would waive the charge for any
-- pair at all. The flag is still recorded on the match, because it is true and useful; it simply
-- has no authority over money.
--
-- is_admin is read under FOR SHARE, so the value cannot change between the decision and the debit.
-- Neither Daniel's email nor his uuid appears anywhere in this function: the property is durable
-- data, and a second administrator, or a change of administrator, needs no migration.
--
-- ── WHY credit_transactions AND NOT A NEW TABLE ────────────────────────────────────────────────
--
-- The credits system already has authoritative ledgers for money IN:
--     public.credit_grants           (052) - Stripe credit-pack purchases, idempotent
--     public.credit_refills + membership_credit_cycles (053) - monthly membership refills
--     public.credit_transactions           - the general transaction log, and the ONLY place any
--                                            debit has ever been written (facilitate-intro)
--
-- What is missing is not a table. It is a debit that is guaranteed to be written. Adding a fourth
-- table would create precisely the second ambiguous source of truth this work is meant to remove:
-- two places to look for "was this member charged", disagreeing whenever one write path was missed.
-- So credit_transactions is extended in place, and it keeps its meaning: every credit movement.
--
-- Extending it is also the SAFE choice, which is not obvious and is worth stating. The table was
-- created out of band and its existing rows are of unknown shape. Every addition here is therefore
-- nullable, and uniqueness is enforced by a PARTIAL index scoped to rows that carry the new
-- event_key. No legacy row participates, so the migration cannot fail on historical data, and no
-- historical row is rewritten or reinterpreted.
--
-- ── FREE-CREDIT-ONLY SPEND IS PRESERVED, DELIBERATELY ──────────────────────────────────────────
--
-- The gate stays `free_credits >= 1`, so a member holding only PREMIUM credits is still refused
-- with insufficient_credits_* despite a positive balance. Premium credits are, today, unspendable
-- on an introduction. That is a live product/accounting question, it is documented in
-- docs/FOLLOWUP_FREE_CREDIT_ONLY_SPEND.md, and it is deliberately NOT changed inside an emergency
-- credit-integrity migration where nobody is reviewing for spend-order changes.
--
-- ── PRESERVED EXACTLY ──────────────────────────────────────────────────────────────────────────
-- signature, RETURNS TABLE(match_id, conversation_id, error_code) and its column order, plpgsql,
-- VOLATILE, SECURITY DEFINER, empty search_path, full schema qualification, insufficient_credits_a,
-- insufficient_credits_b with A's deduction rolled back, duplicate_match with BOTH rolled back,
-- match creation, conversation creation, admin_facilitated recording, and the balance expression
--     balance = (free_credits - 1) + COALESCE(premium_credits, 0)
-- copied verbatim from the audited definition (it re-derives the 052 invariant from the pre-update
-- value rather than decrementing, so it also repairs a drifted row).
--
-- Migrations 063-071 are untouched. Nothing here grants PUBLIC/anon/authenticated anything, and
-- nothing restores service_role EXECUTE on the raw delegate, which migration 068 removed.
-- ==============================================================================================

BEGIN;

-- ── 1. The debit ledger: credit_transactions, extended ────────────────────────────────────────
ALTER TABLE public.credit_transactions
  ADD COLUMN IF NOT EXISTS event_key   text NULL,
  ADD COLUMN IF NOT EXISTS source_kind text NULL,
  ADD COLUMN IF NOT EXISTS source_id   uuid NULL;

COMMENT ON COLUMN public.credit_transactions.event_key IS
  'Immutable identity of a ledgered credit movement, e.g. match_debit:<match_id>:<user_id>. Unique among rows that carry one, so the same movement can never be recorded twice. NULL on legacy rows written before migration 072.';
COMMENT ON COLUMN public.credit_transactions.source_kind IS
  'What caused the movement: match_debit, match_exempt_admin, match_refund. NULL on legacy rows.';
COMMENT ON COLUMN public.credit_transactions.source_id IS
  'Durable reference to the causing artifact - for match movements, public.matches.id.';

-- PARTIAL: legacy rows have a NULL event_key and are untouched by this constraint, so the index
-- build cannot fail on historical duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_event_key_uniq
  ON public.credit_transactions (event_key)
  WHERE event_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS credit_transactions_source_idx
  ON public.credit_transactions (source_kind, source_id)
  WHERE source_kind IS NOT NULL;

-- ── 2. Append-only enforcement for ledgered rows ──────────────────────────────────────────────
-- A ledger that can be edited is a log, not a ledger. Rows carrying an event_key are immutable:
-- a correction is a NEW compensating row, never an edit of the original. Legacy rows are left
-- mutable so this cannot break existing admin tooling.
CREATE OR REPLACE FUNCTION public.tg_credit_transactions_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $tg$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.event_key IS NOT NULL THEN
      RAISE EXCEPTION 'credit_transactions rows carrying an event_key are append-only and cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.event_key IS NOT NULL THEN
    RAISE EXCEPTION 'credit_transactions rows carrying an event_key are append-only and cannot be modified';
  END IF;
  RETURN NEW;
END;
$tg$;

REVOKE ALL ON FUNCTION public.tg_credit_transactions_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tg_credit_transactions_append_only() FROM anon, authenticated;

DROP TRIGGER IF EXISTS credit_transactions_append_only ON public.credit_transactions;
CREATE TRIGGER credit_transactions_append_only
  BEFORE UPDATE OR DELETE ON public.credit_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_credit_transactions_append_only();

-- Restate the privilege posture (055 already revoked browser DML; this is belt-and-braces and
-- makes the contract visible in one place).
ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.credit_transactions FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.credit_transactions FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.credit_transactions TO service_role;

-- ── 3. The single atomic authority ────────────────────────────────────────────────────────────
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
BEGIN
  BEGIN
    -- 3a. WHO ARE THESE PEOPLE? Read under FOR SHARE so is_admin cannot change between this
    --     decision and the debits below. Ordered by id for a deterministic lock sequence.
    --     p_admin_facilitated is NOT consulted here and has no authority over money.
    SELECT count(*) FILTER (WHERE pr.is_admin IS TRUE), count(*)
      INTO v_admin_count, v_participants
    FROM (
      SELECT p.id, p.is_admin
      FROM public.profiles p
      WHERE p.id IN (p_user_a, p_user_b)
      ORDER BY p.id
      FOR SHARE
    ) pr;

    -- A participant we cannot see is a participant we cannot judge. Refuse rather than guess.
    IF v_participants < 2 THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'participant_not_found'::text;
      RETURN;
    END IF;

    v_chargeable := (v_admin_count = 0);

    IF v_chargeable THEN
      UPDATE public.meeting_credits
      SET free_credits = free_credits - 1,
          balance = (free_credits - 1) + COALESCE(premium_credits, 0)
      WHERE user_id = p_user_a AND free_credits >= 1;

      -- Nothing written yet, so there is nothing to unwind here.
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
    END IF;

    INSERT INTO public.matches (user_a_id, user_b_id, admin_facilitated)
    VALUES (p_user_a, p_user_b, p_admin_facilitated)
    RETURNING id INTO v_match_id;

    INSERT INTO public.conversations (match_id) VALUES (v_match_id) RETURNING id INTO v_conversation_id;

    -- 3b. THE ATTRIBUTABLE EVENT, in the SAME transaction as the balance change. A crash cannot
    --     leave a debit without its record, because there is no moment where one exists alone.
    --     event_key makes a repeat physically impossible rather than merely unlikely.
    IF v_chargeable THEN
      INSERT INTO public.credit_transactions (user_id, amount, type, note, event_key, source_kind, source_id)
      VALUES
        (p_user_a, -1, 'deduction', 'Mutual introduction finalized',
         'match_debit:' || v_match_id::text || ':' || p_user_a::text, 'match_debit', v_match_id),
        (p_user_b, -1, 'deduction', 'Mutual introduction finalized',
         'match_debit:' || v_match_id::text || ':' || p_user_b::text, 'match_debit', v_match_id);
    ELSE
      -- A non-charge is also an event. Recording it is what makes "why was nobody charged?"
      -- answerable a year from now without re-deriving it from is_admin.
      INSERT INTO public.credit_transactions (user_id, amount, type, note, event_key, source_kind, source_id)
      VALUES
        (p_user_a, 0, 'exempt', 'Admin participant - no charge',
         'match_exempt:' || v_match_id::text || ':' || p_user_a::text, 'match_exempt_admin', v_match_id),
        (p_user_b, 0, 'exempt', 'Admin participant - no charge',
         'match_exempt:' || v_match_id::text || ':' || p_user_b::text, 'match_exempt_admin', v_match_id);
    END IF;
  EXCEPTION
    -- Covers a duplicate match in either participant order (the UNIQUE on matches) AND a duplicate
    -- ledger event. Every deduction made above is unwound with it.
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

REVOKE ALL ON FUNCTION public.consume_credits_and_create_match(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_credits_and_create_match(uuid, uuid, boolean) FROM anon, authenticated;
-- service_role is NOT granted EXECUTE. Migration 068 removed it deliberately: the only supported
-- entry point is public.finalize_mutual_match_atomic, which revalidates consent under the canonical
-- member advisory locks and calls this function as its owner.

COMMENT ON FUNCTION public.consume_credits_and_create_match(uuid, uuid, boolean) IS
  'Single atomic authority for introduction finalization: decides chargeability from the PARTICIPANTS (profiles.is_admin, read FOR SHARE - never from p_admin_facilitated), deducts one free credit from each chargeable member, creates the match and conversation, and writes an immutable, idempotent credit_transactions event for every participant whether charged or exempt. Match, conversation, debits and ledger succeed or fail together.';

COMMIT;
