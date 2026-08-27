-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- RECONCILE public.meeting_credits.balance — GATE IS FALSE. As checked in, this changes nothing.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Eleven production rows violate balance = free_credits + premium_credits. This sets `balance` to
-- the sum of its buckets on exactly those rows and touches nothing else.
--
-- ─── WHY THEY DRIFTED, AND WHY THE FIX IS SAFE ────────────────────────────────────────────────
-- app/actions.ts adminAdjustCredits read `balance` alone and upserted { user_id, balance }, never
-- touching free_credits or premium_credits. Each ±1 adjustment moved balance by 1 while the
-- buckets stayed put. The BUCKETS are therefore the surviving truth and `balance` is the corrupted
-- denormalisation — which is why this repair recomputes balance FROM the buckets and never the
-- reverse. Rewriting a bucket would invent credits or destroy purchased ones.
--
-- That writer is fixed in the same review as this file. Applying this repair before that fix is
-- deployed would let the drift return.
--
-- ─── WHAT IT MAY TOUCH ────────────────────────────────────────────────────────────────────────
--   balance     -> free_credits + premium_credits
--   updated_at  -> now()
-- Nothing else. free_credits, premium_credits, lifetime_earned, user_id and every other column are
-- proven unchanged by a whole-row jsonb diff before COMMIT.
--
-- Running it as-is performs the repair, verifies it, prints before/after, then RAISEs — which rolls
-- everything back. Applying means changing ONE literal, v_apply. Idempotent: a second run finds
-- nothing to fix and reports 0 rows.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $repair$
DECLARE
  -- ─────────────────────────────────────────────────────────────────────────────────────────────
  -- THE OPERATOR GATE. false = dry run: everything runs, is verified, then rolled back.
  v_apply constant boolean := false;

  -- PINNED EXPECTATIONS from the reviewed census. The repair refuses if production no longer
  -- matches, because a different population means a different diagnosis.
  c_expect_drifted        constant integer := 11;   -- rows where balance <> free + premium
  c_expect_max_drift      constant integer := 1;    -- greatest |balance - (free+premium)|
  c_expect_negative_free  constant integer := 0;
  c_expect_negative_prem  constant integer := 0;
  c_expect_negative_bal   constant integer := 0;
  -- ─────────────────────────────────────────────────────────────────────────────────────────────

  v_drifted   integer;
  v_maxdrift  integer;
  v_n         integer;
  v_changed   integer := 0;
  v_before    jsonb;
  v_after     jsonb;
  v_bad_keys  text[];
  c_allowed   constant text[] := ARRAY['balance','updated_at'];
BEGIN
  IF to_regclass('public.meeting_credits') IS NULL THEN
    RAISE EXCEPTION 'REPAIR REFUSED: public.meeting_credits is missing.';
  END IF;

  -- ── PRECONDITIONS: the population must match the review ────────────────────────────────────
  SELECT count(*), COALESCE(max(abs(COALESCE(balance,0)
                                    - (COALESCE(free_credits,0) + COALESCE(premium_credits,0)))), 0)
    INTO v_drifted, v_maxdrift
  FROM public.meeting_credits
  WHERE COALESCE(balance,0) <> COALESCE(free_credits,0) + COALESCE(premium_credits,0);

  IF v_drifted <> c_expect_drifted THEN
    RAISE EXCEPTION
      'REPAIR REFUSED: % drifted row(s), expected %. Re-run the census and re-review before repairing.',
      v_drifted, c_expect_drifted;
  END IF;
  IF v_maxdrift <> c_expect_max_drift THEN
    RAISE EXCEPTION
      'REPAIR REFUSED: maximum drift is %, expected %. A larger drift is a different defect.',
      v_maxdrift, c_expect_max_drift;
  END IF;

  SELECT count(*) INTO v_n FROM public.meeting_credits WHERE COALESCE(free_credits,0) < 0;
  IF v_n <> c_expect_negative_free THEN
    RAISE EXCEPTION 'REPAIR REFUSED: % negative free_credits row(s), expected %.', v_n, c_expect_negative_free;
  END IF;
  SELECT count(*) INTO v_n FROM public.meeting_credits WHERE COALESCE(premium_credits,0) < 0;
  IF v_n <> c_expect_negative_prem THEN
    RAISE EXCEPTION 'REPAIR REFUSED: % negative premium_credits row(s), expected %.', v_n, c_expect_negative_prem;
  END IF;
  SELECT count(*) INTO v_n FROM public.meeting_credits WHERE COALESCE(balance,0) < 0;
  IF v_n <> c_expect_negative_bal THEN
    RAISE EXCEPTION 'REPAIR REFUSED: % negative balance row(s), expected %.', v_n, c_expect_negative_bal;
  END IF;

  -- Whole-table snapshot, so "nothing else moved" is provable rather than asserted.
  SELECT COALESCE(jsonb_object_agg(user_id::text, to_jsonb(m)), '{}'::jsonb) INTO v_before
  FROM public.meeting_credits m;

  RAISE NOTICE 'BEFORE — % drifted row(s), maximum drift %.', v_drifted, v_maxdrift;

  -- ── THE ONLY WRITE ─────────────────────────────────────────────────────────────────────────
  -- Recompute balance FROM the buckets, on drifted rows only. Never the reverse.
  UPDATE public.meeting_credits
  SET balance    = COALESCE(free_credits,0) + COALESCE(premium_credits,0),
      updated_at = pg_catalog.now()
  WHERE COALESCE(balance,0) <> COALESCE(free_credits,0) + COALESCE(premium_credits,0);
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  SELECT COALESCE(jsonb_object_agg(user_id::text, to_jsonb(m)), '{}'::jsonb) INTO v_after
  FROM public.meeting_credits m;

  -- ── NOTHING OUTSIDE balance / updated_at MOVED, ON ANY ROW ─────────────────────────────────
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT k ORDER BY k), ARRAY[]::text[]) INTO v_bad_keys
  FROM jsonb_each(v_before) b
  CROSS JOIN LATERAL jsonb_object_keys(b.value) AS k
  WHERE (b.value -> k) IS DISTINCT FROM ((v_after -> b.key) -> k)
    AND k <> ALL (c_allowed);
  IF pg_catalog.array_length(v_bad_keys, 1) > 0 THEN
    RAISE EXCEPTION 'REPAIR ABORTED: columns outside the allowed set changed: %. Allowed: %.',
      pg_catalog.array_to_string(v_bad_keys, ', '), pg_catalog.array_to_string(c_allowed, ', ');
  END IF;

  -- No row appeared or vanished.
  IF (SELECT count(*) FROM jsonb_object_keys(v_before)) <> (SELECT count(*) FROM jsonb_object_keys(v_after)) THEN
    RAISE EXCEPTION 'REPAIR ABORTED: the row count changed.';
  END IF;

  -- ── POSTCONDITION: zero drift, and no bucket went negative ─────────────────────────────────
  SELECT count(*) INTO v_n FROM public.meeting_credits
   WHERE COALESCE(balance,0) <> COALESCE(free_credits,0) + COALESCE(premium_credits,0);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'REPAIR ABORTED: % row(s) still violate the invariant.', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.meeting_credits
   WHERE COALESCE(free_credits,0) < 0 OR COALESCE(premium_credits,0) < 0 OR COALESCE(balance,0) < 0;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'REPAIR ABORTED: % row(s) have a negative bucket or balance.', v_n;
  END IF;

  RAISE NOTICE 'AFTER  — % row(s) repaired; 0 remaining violations; no bucket changed.', v_changed;

  IF NOT v_apply THEN
    RAISE EXCEPTION
      'DRY RUN COMPLETE — NOTHING WAS KEPT. % row(s) would be repaired. Every guard passed and '
      'this exception rolls it all back. Set v_apply := true to apply.', v_changed;
  END IF;

  RAISE NOTICE 'REPAIR APPLIED — % row(s) changed.', v_changed;
END
$repair$;

-- Reachable ONLY when v_apply was true. With the gate false the block above raises, the transaction
-- aborts, and PostgreSQL treats this as a ROLLBACK.
COMMIT;
