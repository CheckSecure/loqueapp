-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 088 — ENFORCE balance = free_credits + premium_credits
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- APPLY ONLY AFTER the reconciliation repair has run and the post-repair audit reports zero drift.
--
-- ─── WHY THIS IS A SEPARATE MIGRATION, AND WHY IT REFUSES ─────────────────────────────────────
-- Eleven rows violated the invariant when 087 was written. A CHECK added while violations exist
-- has two bad outcomes and no good one:
--   • added as VALID, the table scan fails and the migration aborts;
--   • added as NOT VALID, existing rows are skipped — but any later UPDATE to one of those rows
--     must satisfy the constraint, so a monthly refill or a match debit touching a drifted member
--     would start failing at runtime, in production, with no warning.
-- So this migration REFUSES to run while any violation remains, rather than choosing between them.
-- The safe sequence is: 087 → deploy → repair → post-repair audit → 088.
--
-- The constraint is added VALID in one step. That is deliberate: with zero violations the scan is
-- the proof, and NOT VALID + VALIDATE would leave a window in which the invariant is only
-- half-enforced for no benefit.
--
-- No row is inserted, updated, deleted or backfilled.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $precheck$
DECLARE v_n integer; v_max integer;
BEGIN
  IF to_regclass('public.meeting_credits') IS NULL THEN
    RAISE EXCEPTION '088 REFUSED: public.meeting_credits is missing.';
  END IF;

  SELECT count(*), COALESCE(max(abs(COALESCE(balance,0)
                                    - (COALESCE(free_credits,0) + COALESCE(premium_credits,0)))), 0)
    INTO v_n, v_max
  FROM public.meeting_credits
  WHERE COALESCE(balance,0) <> COALESCE(free_credits,0) + COALESCE(premium_credits,0);

  IF v_n <> 0 THEN
    RAISE EXCEPTION
      '088 REFUSED: % row(s) still violate balance = free_credits + premium_credits '
      '(maximum drift %). Run supabase/repairs/meeting_credits_balance_reconciliation.PROPOSED.sql '
      'and confirm the post-repair audit reports zero drift, THEN apply 088.', v_n, v_max;
  END IF;

  -- The writer that caused the drift must already be fixed, or the constraint will start rejecting
  -- admin adjustments in production. SQL cannot check which commit is deployed; the preflight
  -- states it as an operator confirmation. This notice is the reminder.
  RAISE NOTICE '088 precheck passed: zero violations. Confirm the adminAdjustCredits fix is DEPLOYED.';
END
$precheck$;

DO $add$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                 JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
                 JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
                 WHERE n.nspname='public' AND t.relname='meeting_credits'
                   AND c.conname='meeting_credits_balance_invariant') THEN
    ALTER TABLE public.meeting_credits
      ADD CONSTRAINT meeting_credits_balance_invariant
      CHECK (COALESCE(balance,0) = COALESCE(free_credits,0) + COALESCE(premium_credits,0));
  END IF;
END
$add$;

-- Buckets may not go negative either. Separate constraint so a violation names the actual problem.
DO $add2$
BEGIN
  IF EXISTS (SELECT 1 FROM public.meeting_credits
             WHERE COALESCE(free_credits,0) < 0 OR COALESCE(premium_credits,0) < 0) THEN
    RAISE EXCEPTION '088 REFUSED: a negative bucket exists; the non-negative constraint would fail.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                 JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
                 JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
                 WHERE n.nspname='public' AND t.relname='meeting_credits'
                   AND c.conname='meeting_credits_buckets_non_negative') THEN
    ALTER TABLE public.meeting_credits
      ADD CONSTRAINT meeting_credits_buckets_non_negative
      CHECK (COALESCE(free_credits,0) >= 0 AND COALESCE(premium_credits,0) >= 0);
  END IF;
END
$add2$;

DO $verify$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_catalog.pg_constraint c
  JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname='public' AND t.relname='meeting_credits'
    AND c.conname IN ('meeting_credits_balance_invariant','meeting_credits_buckets_non_negative')
    AND c.contype='c' AND c.convalidated;
  IF v_n <> 2 THEN
    RAISE EXCEPTION '088 FAILED: expected 2 validated CHECK constraints, found %.', v_n;
  END IF;
  RAISE NOTICE '088 APPLIED: the additive balance invariant and non-negative buckets are enforced.';
END
$verify$;

COMMIT;
