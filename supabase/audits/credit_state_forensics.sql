-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- CREDIT STATE FORENSICS — reconstruct how one account reached its current numbers
--
-- STRICTLY READ-ONLY. One statement, SELECT + CTEs only. No DML, DDL, locks, temporary objects,
-- dynamic SQL or mutating calls. It mutates nothing and it fixes nothing.
--
-- IDENTIFIER-BEARING BY NECESSITY. It emits user_id for the accounts it examines, because you
-- cannot reconstruct an individual account's history from an aggregate. It emits NO name and NO
-- email. Treat the output as operator-only.
--
-- ─── WHY ───────────────────────────────────────────────────────────────────────────────────────
-- Production holds an account with balance = -1. No credit path should be able to produce that, so
-- either a path has no lower bound or something wrote the columns directly. This query lays every
-- known inflow and outflow beside the stored numbers so the gap is visible rather than inferred.
--
-- ─── WHAT THE CODEBASE SAYS CAN MOVE CREDITS ───────────────────────────────────────────────────
--   public.consume_credits_and_create_match   free -1, balance recomputed. Gated on free >= 1.
--   grant_credit_pack (052)                   additive. Cannot go negative.
--   membership refills (053)                  additive. Cannot go negative.
--   api/profile/complete                      onboarding grant. Additive.
--   api/targeted-request/submit               premium -1, balance recomputed. Gated on premium >= 1.
--   api/admin/facilitate-intro                balance -1 ONLY. Gated on balance >= 1, so it cannot
--                                             itself go negative, but it BREAKS the invariant on
--                                             every call by leaving free_credits untouched.
--   adminUpdateMember (app/actions.ts)        set balance to an ARBITRARY admin-supplied number,
--                                             with NO lower bound and NO recomputation.
--
-- Exactly one of those has no lower bound. `invariant_drift` and `negative_source_hint` below are
-- what separate "an admin typed it" from "a debit path went negative".
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

WITH
target AS (
  -- Accounts worth reconstructing: any stored-state inconsistency at all.
  SELECT user_id FROM public.meeting_credits
  WHERE COALESCE(balance, 0) < 0
     OR COALESCE(free_credits, 0) < 0
     OR COALESCE(premium_credits, 0) < 0
     OR COALESCE(balance, 0) <> COALESCE(free_credits, 0) + COALESCE(premium_credits, 0)
),
g AS (SELECT user_id, COALESCE(SUM(credits),0) AS granted, count(*) AS grant_rows
      FROM public.credit_grants WHERE user_id IN (SELECT user_id FROM target) GROUP BY user_id),
r AS (SELECT user_id, COALESCE(SUM(included_credits),0) AS refilled, count(*) AS refill_rows
      FROM public.credit_refills WHERE user_id IN (SELECT user_id FROM target) GROUP BY user_id),
t AS (SELECT user_id,
             COALESCE(SUM(amount) FILTER (WHERE amount > 0),0)      AS txn_positive,
             COALESCE(SUM(amount) FILTER (WHERE amount < 0),0) * -1 AS txn_negative,
             count(*)                                               AS txn_rows,
             count(*) FILTER (WHERE event_key IS NOT NULL)          AS txn_ledgered_rows
      FROM public.credit_transactions WHERE user_id IN (SELECT user_id FROM target) GROUP BY user_id),
m AS (
  SELECT x.user_id,
         count(*)                                                   AS matches_total,
         count(*) FILTER (WHERE x.other_is_admin OR x.self_is_admin) AS admin_participant_matches,
         count(*) FILTER (WHERE NOT x.other_is_admin AND NOT x.self_is_admin) AS ordinary_matches
  FROM (
    SELECT y.user_id, COALESCE(p.is_admin,false) AS other_is_admin, COALESCE(sp.is_admin,false) AS self_is_admin
    FROM (
      SELECT user_a_id AS user_id, user_b_id AS other_id FROM public.matches
      UNION ALL SELECT user_b_id, user_a_id FROM public.matches
    ) y
    LEFT JOIN public.profiles p  ON p.id  = y.other_id
    LEFT JOIN public.profiles sp ON sp.id = y.user_id
  ) x
  WHERE x.user_id IN (SELECT user_id FROM target)
  GROUP BY x.user_id
),
tr AS (SELECT user_id, count(*) AS targeted_requests
       FROM public.targeted_requests WHERE user_id IN (SELECT user_id FROM target) GROUP BY user_id)

SELECT
  mc.user_id,
  COALESCE(pr.is_admin, false)            AS is_admin,
  COALESCE(pr.is_test_account, false)     AS is_test_account,
  COALESCE(pr.account_status, 'unknown')  AS account_status,
  -- stored state
  COALESCE(mc.free_credits, 0)            AS free_credits,
  COALESCE(mc.premium_credits, 0)         AS premium_credits,
  COALESCE(mc.balance, 0)                 AS balance,
  COALESCE(mc.lifetime_earned, 0)         AS lifetime_earned,
  -- how far the stored balance is from its own definition
  COALESCE(mc.balance,0) - COALESCE(mc.free_credits,0) - COALESCE(mc.premium_credits,0) AS invariant_drift,
  -- inflows, from the authoritative per-source ledgers
  COALESCE(g.granted, 0)                  AS purchased_credits,
  COALESCE(g.grant_rows, 0)               AS purchase_events,
  COALESCE(r.refilled, 0)                 AS refilled_credits,
  COALESCE(r.refill_rows, 0)              AS refill_events,
  COALESCE(t.txn_positive, 0)             AS transaction_credits_in,
  -- outflows that were actually recorded
  COALESCE(t.txn_negative, 0)             AS transaction_credits_out,
  COALESCE(t.txn_rows, 0)                 AS transaction_rows,
  COALESCE(t.txn_ledgered_rows, 0)        AS ledgered_rows,
  -- consumption the code could have caused but may not have recorded
  COALESCE(m.matches_total, 0)            AS matches_total,
  COALESCE(m.admin_participant_matches,0) AS admin_participant_matches,
  COALESCE(m.ordinary_matches, 0)         AS ordinary_matches,
  COALESCE(tr.targeted_requests, 0)       AS targeted_requests,
  -- expected balance from everything that IS recorded
  (COALESCE(g.granted,0) + COALESCE(r.refilled,0) + COALESCE(t.txn_positive,0) - COALESCE(t.txn_negative,0))
    AS expected_balance_from_ledgers,
  (COALESCE(g.granted,0) + COALESCE(r.refilled,0) + COALESCE(t.txn_positive,0) - COALESCE(t.txn_negative,0))
    - COALESCE(mc.balance,0) AS unexplained_shortfall,
  -- WHICH PATH. Every debit path has a lower bound except the admin setter, so a negative balance
  -- or a drift that no debit path could produce points at a direct write.
  CASE
    WHEN COALESCE(mc.free_credits,0) < 0 OR COALESCE(mc.premium_credits,0) < 0
      THEN 'direct_write: a bucket itself is negative; no gated debit path can do this'
    WHEN COALESCE(mc.balance,0) < 0
      THEN 'direct_write_or_admin_setter: every debit path is gated at >= 1, so none can reach a negative balance'
    WHEN COALESCE(mc.balance,0) <> COALESCE(mc.free_credits,0) + COALESCE(mc.premium_credits,0)
     AND COALESCE(mc.free_credits,0) >= 0
      THEN 'balance_only_writer: consistent with facilitate-intro or the admin setter, which move balance without recomputing it'
    ELSE 'consistent'
  END AS negative_source_hint
FROM public.meeting_credits mc
LEFT JOIN public.profiles pr ON pr.id = mc.user_id
LEFT JOIN g  ON g.user_id  = mc.user_id
LEFT JOIN r  ON r.user_id  = mc.user_id
LEFT JOIN t  ON t.user_id  = mc.user_id
LEFT JOIN m  ON m.user_id  = mc.user_id
LEFT JOIN tr ON tr.user_id = mc.user_id
WHERE mc.user_id IN (SELECT user_id FROM target)
ORDER BY COALESCE(mc.balance, 0), mc.user_id;
