-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 087 — CREDIT RELEASE 1: spend purchased credits, and take the balance table away from browsers
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- TWO DEFECTS, ONE MIGRATION, because the second makes the first meaningless if left open.
--
-- (1) PURCHASED CREDITS CANNOT BE SPENT. public.consume_credits_and_create_match debits
--     `free_credits` only (`WHERE free_credits >= 1`). A member holding free_credits = 0 and
--     premium_credits = 12 sees a balance of 12 and is refused every introduction with
--     insufficient_credits_a/_b. They paid for credits the product will not let them use.
--
-- (2) public.meeting_credits IS HARDENED OUT OF BAND, INCONSISTENTLY. No migration in this
--     repository has ever touched its privileges, but production is NOT unprotected: the credit
--     census reports RLS ENABLED (not forced) and FIVE policies, four of them hand-named in the
--     Supabase dashboard. What production DOES still hold is all seven TABLE privileges for anon,
--     authenticated AND service_role — so the only thing standing between a logged-in member and
--     an UPDATE of their own balance is a policy nobody wrote down.
--
--     This migration replaces that with a posture the repository states: no privilege at all for
--     PUBLIC and anon, SELECT only for authenticated, exactly one own-row SELECT policy, and the
--     three privileges the audited server writers actually need for service_role.
--
-- ─── ORDER MATTERS: THE APPLICATION CHANGE SHIPS FIRST ────────────────────────────────────────
-- app/dashboard/admin/members/page.tsx read every member's credits with the COOKIE-SESSION client
-- and no user_id filter. The self-row policy created below would silently reduce that to the
-- administrator's own row. That read was moved to service_role in the same review as this file and
-- MUST be deployed before this migration is applied. The preflight states it as an operator
-- confirmation, because SQL cannot check which commit is live.
--
-- ─── WHAT IS DELIBERATELY NOT IN THIS MIGRATION ───────────────────────────────────────────────
-- No balance CHECK constraint. Eleven production rows currently violate
-- balance = free_credits + premium_credits, and a constraint added while violations exist either
-- fails validation or silently blocks later writes to those rows. The invariant is migration 088,
-- applied only after supabase/repairs/meeting_credits_balance_reconciliation.PROPOSED.sql has run
-- and the post-repair audit reports zero drift. Monthly additive refills, the 20-credit included
-- cap, purchase reservations and the combined 50-credit cap are all out of scope here.
--
-- No row is inserted, updated, deleted or backfilled. Transactional and fail-closed.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── SECTION 0 — PRECONDITIONS ────────────────────────────────────────────────────────────────
DO $precheck$
DECLARE v_missing text;
BEGIN
  IF to_regclass('public.meeting_credits') IS NULL THEN
    RAISE EXCEPTION '087 REFUSED: public.meeting_credits is missing.';
  END IF;
  IF to_regclass('public.credit_transactions') IS NULL THEN
    RAISE EXCEPTION '087 REFUSED: public.credit_transactions is missing (migration 072 not applied?).';
  END IF;
  -- 072 must be deployed: this migration REPLACES its function and relies on its ledger columns.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='credit_transactions'
                   AND column_name='event_key') THEN
    RAISE EXCEPTION '087 REFUSED: credit_transactions.event_key is absent — migration 072 is not applied.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='public' AND p.proname='consume_credits_and_create_match') THEN
    RAISE EXCEPTION '087 REFUSED: public.consume_credits_and_create_match does not exist.';
  END IF;
  SELECT pg_catalog.string_agg(x.rolname, ', ') INTO v_missing
  FROM (VALUES ('anon'),('authenticated'),('service_role')) AS x(rolname)
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = x.rolname);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '087 REFUSED: expected role(s) not present: %.', v_missing;
  END IF;
  RAISE NOTICE '087 preconditions passed.';
END
$precheck$;

-- ── SECTION 1 — WHICH BUCKET FUNDED A DEBIT ──────────────────────────────────────────────────
-- Added as a NULLABLE column so every historical row stays valid without a backfill, and so the
-- append-only trigger is untouched: that trigger blocks UPDATE and DELETE on rows, which ADD COLUMN
-- is not. It carries a bucket NAME, never an amount, a balance or anything about the member, and
-- public.credit_transactions is not readable by any browser role — so this adds no exposure. It is
-- a real column rather than text appended to `note` because "how many debits came out of purchased
-- credits" should be answerable with a GROUP BY, not a LIKE.
ALTER TABLE public.credit_transactions
  ADD COLUMN IF NOT EXISTS funded_from text NULL;

DO $ck$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conname = 'credit_transactions_funded_from_ck') THEN
    ALTER TABLE public.credit_transactions
      ADD CONSTRAINT credit_transactions_funded_from_ck
      CHECK (funded_from IS NULL OR funded_from IN ('included','purchased'));
  END IF;
END
$ck$;

COMMENT ON COLUMN public.credit_transactions.funded_from IS
  'Which bucket funded a match debit: included (free_credits) or purchased (premium_credits). NULL for rows written before migration 087 and for non-debit events. Never member data.';

-- ── SECTION 2 — THE SPEND ORDER ──────────────────────────────────────────────────────────────
-- Transcribed from migration 072 with THREE changes and nothing else:
--   (a) both credit rows are locked FOR UPDATE in deterministic UUID order before any debit, so
--       two concurrent finalizations of the same pair in opposite argument orders cannot deadlock;
--   (b) the debit takes ONE credit from free_credits when free_credits > 0, otherwise ONE from
--       premium_credits — never both, never a split;
--   (c) the ledger event records funded_from.
-- Chargeability, the FOR SHARE read of is_admin, participant_not_found, the unwind-by-RAISE for
-- member B, match/conversation creation, the exempt-admin events, event_key idempotency and every
-- returned error code are unchanged.
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

REVOKE ALL ON FUNCTION public.consume_credits_and_create_match(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_credits_and_create_match(uuid, uuid, boolean) FROM anon, authenticated;
-- service_role is deliberately NOT granted EXECUTE, exactly as migration 068 left it: the only
-- supported entry point remains public.finalize_mutual_match_atomic.

COMMENT ON FUNCTION public.consume_credits_and_create_match(uuid, uuid, boolean) IS
  'Single atomic authority for introduction finalization. Chargeability is decided from the PARTICIPANTS (profiles.is_admin, read FOR SHARE). Both credit rows are locked FOR UPDATE in ascending user_id order. Each chargeable member is debited ONE credit: included (free_credits) first, purchased (premium_credits) second, never both. balance is recomputed. Match, conversation, debits and the idempotent ledger event succeed or fail together.';

-- ── SECTION 3 — meeting_credits ACL + RLS ────────────────────────────────────────────────────
ALTER TABLE public.meeting_credits ENABLE ROW LEVEL SECURITY;

-- ── THE FIVE EXISTING POLICIES ARE REMOVED DELIBERATELY, BY NAME ───────────────────────────
-- Created out of band; no migration authored any of them. They are dropped rather than left
-- alongside the new one because PERMISSIVE policies UNION: leaving "Only admins can update
-- credits" in place would keep an UPDATE path alive the moment anyone re-granted UPDATE. The
-- preflight prints their full expressions before this runs — that output is the only record of
-- what they said. Names are double-quoted: four contain spaces and capitals.
DROP POLICY IF EXISTS "Only admins can delete credits"              ON public.meeting_credits;
DROP POLICY IF EXISTS "Only admins can insert credits"              ON public.meeting_credits;
DROP POLICY IF EXISTS "Only admins can update credits"              ON public.meeting_credits;
DROP POLICY IF EXISTS "Users view own credits or admin views all"   ON public.meeting_credits;
DROP POLICY IF EXISTS credits_select_own                            ON public.meeting_credits;
DROP POLICY IF EXISTS meeting_credits_self_read                     ON public.meeting_credits;
-- The ONLY policy. SELECT only, own row only, authenticated only. There is deliberately no
-- INSERT/UPDATE/DELETE policy: the privileges are revoked below, so a policy for them would be
-- decoration that a future GRANT could quietly activate.
CREATE POLICY meeting_credits_self_read ON public.meeting_credits
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

REVOKE ALL PRIVILEGES ON TABLE public.meeting_credits FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.meeting_credits FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.meeting_credits FROM authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.meeting_credits FROM service_role;

-- Column grants survive a table-level REVOKE. Clear them for every role before granting.
DO $columns$
DECLARE r record; v_role text;
BEGIN
  FOR r IN
    SELECT a.attname FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND c.relname='meeting_credits'
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  LOOP
    FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      EXECUTE pg_catalog.format('REVOKE ALL (%I) ON TABLE public.meeting_credits FROM %I',
                                r.attname, v_role);
    END LOOP;
    EXECUTE pg_catalog.format('REVOKE ALL (%I) ON TABLE public.meeting_credits FROM PUBLIC', r.attname);
  END LOOP;
  RAISE NOTICE '087 column-level grants on meeting_credits cleared.';
END
$columns$;

-- authenticated: SELECT only, and RLS above narrows it to the member's own row. This is what keeps
-- app/dashboard/billing/page.tsx (a browser self-read of `balance`) working.
GRANT SELECT ON TABLE public.meeting_credits TO authenticated;

-- service_role: exactly what the audited writers need and nothing more.
--   SELECT  — 12 server read sites
--   INSERT  — app/api/profile/complete (signup grant), app/actions.ts (upserts)
--   UPDATE  — app/api/profile/complete, app/api/targeted-request/submit, app/actions.ts
--   DELETE  — deliberately NOT granted. No application path deletes a credit row; the only DELETE
--             is inside public.delete_user_account (075), a SECURITY DEFINER function that runs as
--             its owner and therefore does not consult service_role's privileges.
GRANT SELECT, INSERT, UPDATE ON TABLE public.meeting_credits TO service_role;

-- ── SECTION 3b — ATOMIC ADMINISTRATOR CREDIT ADJUSTMENT ──────────────────────────────────────
-- app/actions.ts adminAdjustCredits read the row, computed a new value in JavaScript, and wrote it
-- back. Two concurrent adjustments both read the same starting point and the second overwrote the
-- first — one of them silently lost. That read-modify-write is also what broke the balance
-- invariant on eleven rows, because it wrote `balance` alone.
--
-- This function does the whole thing in one statement sequence under a row lock, so a concurrent
-- caller waits and then reads the ALREADY-ADJUSTED row. Neither adjustment can be lost.
--
-- THE BUCKET DECISION, MADE: a positive administrative adjustment goes into free_credits.
-- premium_credits remains PURCHASED-ONLY, so Stripe reconciliation keeps its meaning — premium
-- exceeding credits_bought would otherwise read as credits appearing without payment.
--
-- TEMPORARY LIMITATION, ACCEPTED FOR RELEASE 1: migration 053's apply_credit_refill REPLACES
-- free_credits with the tier allowance at each anniversary (`free_credits = v_included`), so a
-- positive administrative grant CAN BE REPLACED at the member's next anniversary. Credit Release 2
-- changes refills from replacement to capped addition, which removes the limitation. No third
-- bucket is introduced, here or later.
CREATE OR REPLACE FUNCTION public.admin_adjust_credits(
  p_user_id   uuid,
  p_delta     integer,
  p_reason    text DEFAULT NULL,
  p_event_key text DEFAULT NULL
) RETURNS TABLE (free_credits integer, premium_credits integer, balance integer, applied integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $adj$
DECLARE
  v_free    integer;
  v_prem    integer;
  v_spend   integer;
  v_from_f  integer;
  v_applied integer;
  v_key     text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'admin_adjust_credits: missing user id';
  END IF;
  IF p_delta IS NULL OR p_delta = 0 THEN
    RAISE EXCEPTION 'admin_adjust_credits: delta must be a non-zero integer';
  END IF;
  IF pg_catalog.abs(p_delta) > 100000 THEN
    RAISE EXCEPTION 'admin_adjust_credits: delta out of range';
  END IF;

  -- THE LOCK. A concurrent adjustment blocks here and then reads the adjusted row, so neither is
  -- lost. A member with no credit row gets one, created inside the same transaction.
  INSERT INTO public.meeting_credits (user_id, free_credits, premium_credits, balance, lifetime_earned)
  VALUES (p_user_id, 0, 0, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT COALESCE(mc.free_credits, 0), COALESCE(mc.premium_credits, 0)
    INTO v_free, v_prem
  FROM public.meeting_credits mc
  WHERE mc.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_adjust_credits: no credit row for the member';
  END IF;

  IF p_delta > 0 THEN
    -- Positive: into the included bucket. See the caveat above.
    v_free    := v_free + p_delta;
    v_applied := p_delta;
  ELSE
    -- Negative: included first, purchased second — the same order the match path uses, so an
    -- administrative correction cannot quietly consume purchased credits while included remain.
    -- Clamped at the combined balance so NEITHER bucket can go negative.
    v_spend   := LEAST(-p_delta, v_free + v_prem);
    v_from_f  := LEAST(v_spend, v_free);
    v_free    := v_free - v_from_f;
    v_prem    := v_prem - (v_spend - v_from_f);
    v_applied := -v_spend;   -- what was ACTUALLY applied, which may be less than requested
  END IF;

  IF v_free < 0 OR v_prem < 0 THEN
    RAISE EXCEPTION 'admin_adjust_credits: refusing to drive a bucket negative';
  END IF;

  UPDATE public.meeting_credits mc
  SET free_credits    = v_free,
      premium_credits = v_prem,
      balance         = v_free + v_prem,
      updated_at      = pg_catalog.now()
  WHERE mc.user_id = p_user_id;

  -- THE LEDGER EVENT. event_key is supplied by the caller when it wants replay protection; when
  -- it is NULL the event is still written but is NOT idempotent, because two DELIBERATE identical
  -- adjustments are a legitimate thing for an administrator to do and silently collapsing them
  -- would be worse than recording both. The unique index on event_key does the enforcing.
  v_key := NULLIF(pg_catalog.btrim(COALESCE(p_event_key, '')), '');
  INSERT INTO public.credit_transactions
    (user_id, amount, type, note, event_key, source_kind, source_id, funded_from)
  VALUES
    (p_user_id, v_applied, 'admin_adjustment',
     COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_reason, '')), ''), 'Manual admin adjustment'),
     v_key, 'admin_adjustment', NULL,
     CASE WHEN v_applied >= 0 THEN 'included'
          WHEN (v_spend - v_from_f) > 0 THEN 'purchased'
          ELSE 'included' END);

  RETURN QUERY SELECT v_free, v_prem, v_free + v_prem, v_applied;
END;
$adj$;

REVOKE ALL ON FUNCTION public.admin_adjust_credits(uuid, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_adjust_credits(uuid, integer, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adjust_credits(uuid, integer, text, text) TO service_role;

COMMENT ON FUNCTION public.admin_adjust_credits(uuid, integer, text, text) IS
  'Atomic administrator credit adjustment. Locks the member row FOR UPDATE, adds a positive delta to free_credits, spends a negative delta included-first then purchased, refuses to drive either bucket negative, recomputes balance = free + premium, and writes an attributable credit_transactions event. service_role only; the caller must already have authorized the administrator.';

-- ── SECTION 4 — POSTCONDITIONS (fail closed → whole migration rolls back) ────────────────────
DO $verify$
DECLARE p text; v_n bigint; v_src text;
BEGIN
  -- 4a. Browser roles hold nothing except authenticated SELECT.
  FOREACH p IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
    IF pg_catalog.has_table_privilege('authenticated','public.meeting_credits'::regclass,p) THEN
      RAISE EXCEPTION '087 FAILED: authenticated still holds % on meeting_credits.', p;
    END IF;
    IF pg_catalog.has_table_privilege('anon','public.meeting_credits'::regclass,p) THEN
      RAISE EXCEPTION '087 FAILED: anon still holds % on meeting_credits.', p;
    END IF;
  END LOOP;
  IF NOT pg_catalog.has_table_privilege('authenticated','public.meeting_credits'::regclass,'SELECT') THEN
    RAISE EXCEPTION '087 FAILED: authenticated lost SELECT — the billing page self-read would break.';
  END IF;
  IF pg_catalog.has_table_privilege('anon','public.meeting_credits'::regclass,'SELECT') THEN
    RAISE EXCEPTION '087 FAILED: anon still holds SELECT on meeting_credits.';
  END IF;

  -- 4b. No PUBLIC ACL entry of any privilege type survives.
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) x
  WHERE n.nspname='public' AND c.relname='meeting_credits' AND x.grantee = 0;
  IF v_n <> 0 THEN RAISE EXCEPTION '087 FAILED: % PUBLIC ACL entries remain.', v_n; END IF;

  -- 4c. No EXPLICIT column grant survives for any role (attacl, not information_schema, which
  --     reports a table grant once per column).
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
  WHERE n.nspname='public' AND c.relname='meeting_credits'
    AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION '087 FAILED: % column-level grants remain.', v_n; END IF;

  -- 4d. RLS on, exactly one policy, SELECT only.
  IF NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname='meeting_credits') THEN
    RAISE EXCEPTION '087 FAILED: RLS is not enabled on meeting_credits.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_policies
   WHERE schemaname='public' AND tablename='meeting_credits';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '087 FAILED: expected exactly 1 policy, found % — a policy this migration did '
      'not drop still exists.', v_n;
  END IF;
  -- None of the five may survive, whatever else is true.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policies
             WHERE schemaname='public' AND tablename='meeting_credits'
               AND policyname IN ('Only admins can delete credits','Only admins can insert credits',
                                  'Only admins can update credits',
                                  'Users view own credits or admin views all','credits_select_own')) THEN
    RAISE EXCEPTION '087 FAILED: one of the five superseded policies survived the drop.';
  END IF;
  -- And no write policy of any kind may exist: the privileges are revoked, so a write policy
  -- would be a loaded gun awaiting a future GRANT.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policies
             WHERE schemaname='public' AND tablename='meeting_credits' AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION '087 FAILED: a non-SELECT policy exists on meeting_credits.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies
                 WHERE schemaname='public' AND tablename='meeting_credits'
                   AND policyname='meeting_credits_self_read' AND cmd='SELECT') THEN
    RAISE EXCEPTION '087 FAILED: the self-read policy is missing or is not SELECT-only.';
  END IF;

  -- 4e. service_role has exactly SELECT, INSERT, UPDATE.
  FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE'] LOOP
    IF NOT pg_catalog.has_table_privilege('service_role','public.meeting_credits'::regclass,p) THEN
      RAISE EXCEPTION '087 FAILED: service_role lacks % on meeting_credits.', p;
    END IF;
  END LOOP;
  FOREACH p IN ARRAY ARRAY['DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
    IF pg_catalog.has_table_privilege('service_role','public.meeting_credits'::regclass,p) THEN
      RAISE EXCEPTION '087 FAILED: service_role holds % on meeting_credits.', p;
    END IF;
  END LOOP;

  -- 4f. The spend function now reaches premium_credits.
  SELECT p2.prosrc INTO v_src FROM pg_catalog.pg_proc p2
  JOIN pg_catalog.pg_namespace n ON n.oid=p2.pronamespace
  WHERE n.nspname='public' AND p2.proname='consume_credits_and_create_match' LIMIT 1;
  IF v_src IS NULL OR v_src NOT LIKE '%premium_credits%' THEN
    RAISE EXCEPTION '087 FAILED: the spend function does not reference premium_credits.';
  END IF;
  IF v_src LIKE '%WHERE user_id = p_user_a AND free_credits >= 1%' THEN
    RAISE EXCEPTION '087 FAILED: the free-only debit predicate survived.';
  END IF;
  IF v_src NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION '087 FAILED: the deterministic row lock is missing.';
  END IF;

  -- 4g. The atomic admin authority exists and is service-role only.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p3
                 JOIN pg_catalog.pg_namespace n ON n.oid=p3.pronamespace
                 WHERE n.nspname='public' AND p3.proname='admin_adjust_credits') THEN
    RAISE EXCEPTION '087 FAILED: public.admin_adjust_credits was not created.';
  END IF;
  IF pg_catalog.has_function_privilege('authenticated',
       'public.admin_adjust_credits(uuid, integer, text, text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon',
       'public.admin_adjust_credits(uuid, integer, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '087 FAILED: a browser role can EXECUTE admin_adjust_credits.';
  END IF;
  IF NOT pg_catalog.has_function_privilege('service_role',
       'public.admin_adjust_credits(uuid, integer, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '087 FAILED: service_role cannot EXECUTE admin_adjust_credits.';
  END IF;

  RAISE NOTICE '087 APPLIED: purchased credits are spendable; meeting_credits is browser-read-only '
               'via a single self-row policy with zero write privileges; administrator adjustments '
               'are atomic.';
END
$verify$;

COMMIT;
