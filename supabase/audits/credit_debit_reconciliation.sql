-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- CREDIT DEBIT RECONCILIATION — who lost a credit, and which of those losses are refundable?
--
-- STRICTLY READ-ONLY. One statement, SELECT + CTEs only. No DML, DDL, locks, temp tables, dynamic
-- SQL or mutating calls. Safe against production at any time.
--
-- IDENTIFIER POLICY, STATED DELIBERATELY: Section B emits meeting_credits.user_id, because refunds
-- cannot be issued against an aggregate. It emits NO name, NO email, NO match id, NO conversation
-- id. Sections A and C are aggregate-only.
--
-- ─── WHY NOT `lifetime_earned − balance` ───────────────────────────────────────────────────────
-- That formula was the first thing tried and it is not sufficient on its own: monthly membership
-- refills (053), Stripe credit-pack purchases (052) and manual adjustments all move credits, and
-- lifetime_earned does not track every one of them consistently. Using it alone would invent
-- shortfalls for members whose credits moved for perfectly ordinary reasons.
--
-- So this query models inflow from the AUTHORITATIVE in-ledgers and compares TWO independent
-- estimates. Where they agree, the number is trustworthy. Where they disagree, the account is
-- ambiguous and is routed to manual review rather than to a refund:
--
--     model_1 (ledgers)  expected = credit_grants + credit_refills + positive credit_transactions
--                                   − negative credit_transactions
--     model_2 (lifetime) expected = lifetime_earned − ledgered_debits
--     shortfall_ledgers  = expected(model_1) − balance
--     shortfall_lifetime = expected(model_2) − balance
--
-- ─── THE DEFECT BEING MEASURED ─────────────────────────────────────────────────────────────────
-- public.consume_credits_and_create_match decrements credits and writes NOTHING to any ledger, so
-- every charge it ever made is invisible. Migration 072 fixes that prospectively. This query
-- measures what the gap already cost, and — critically — separates:
--
--   * charges for a genuine mutual member connection: a LEGITIMATE debit that merely lacks a
--     record. Fix the record. DO NOT REFUND.
--   * charges where a participant is the platform administrator: the connection is part of running
--     the platform, not a purchase. REFUNDABLE.
--   * everything the evidence cannot separate: MANUAL REVIEW. Never bulk-refunded.
--
-- ─── ABSENCE OF A LEDGER ROW IS NOT EVIDENCE OF A WRONG CHARGE ────────────────────────────────
-- Before migration 072 NO delegate charge had a ledger row, so "missing row" describes the entire
-- historical population and distinguishes nothing. Refundability is decided by WHO the participants
-- were, not by whether a row exists.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

WITH
-- ── inflows, from the authoritative per-source ledgers ─────────────────────────────────────────
grants AS (SELECT user_id, COALESCE(SUM(credits), 0) AS c FROM public.credit_grants GROUP BY user_id),
refills AS (SELECT user_id, COALESCE(SUM(included_credits), 0) AS c FROM public.credit_refills GROUP BY user_id),
txn AS (
  SELECT user_id,
         COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0)      AS positive,
         COALESCE(SUM(amount) FILTER (WHERE amount < 0), 0) * -1 AS negative,
         COUNT(*)                                                AS rows_all,
         COUNT(*) FILTER (WHERE amount < 0)                      AS rows_debit
  FROM public.credit_transactions GROUP BY user_id
),

-- ── match participation, split by whether a participant is an administrator ────────────────────
-- A delegate-created match sets ONLY (user_a_id, user_b_id, admin_facilitated). Every direct-insert
-- admin path also sets admin_notes and/or status explicitly, so `admin_notes IS NULL` is a shape
-- hint that a match came from the charging path. It is a hint, not an identification.
mp AS (
  SELECT m.user_id,
         COUNT(*)                                                          AS matches_total,
         COUNT(*) FILTER (WHERE m.other_is_admin)                          AS matches_with_admin,
         COUNT(*) FILTER (WHERE NOT m.other_is_admin)                      AS matches_ordinary,
         -- PERSPECTIVE FIX. "counterpart is an admin" is the right test for an ORDINARY member and
         -- meaningless for the ADMINISTRATOR, whose counterparts are ordinary members by definition.
         -- Applied naively it classified the administrator's own erroneous deductions as ordinary
         -- member connections and routed the one account we have direct evidence for into manual
         -- review. For a self_is_admin row, EVERY delegate-shaped match is an operational
         -- connection; for everyone else, only the ones whose counterpart is the administrator.
         COUNT(*) FILTER (
           WHERE m.admin_notes IS NULL AND (m.other_is_admin OR m.self_is_admin)
         )                                                                 AS matches_admin_delegate_shape,
         COUNT(*) FILTER (
           WHERE m.admin_notes IS NULL AND NOT m.other_is_admin AND NOT m.self_is_admin
         )                                                                 AS matches_ordinary_delegate_shape
  FROM (
    SELECT x.user_id, x.other_id, x.admin_notes,
           COALESCE(p.is_admin, false)  AS other_is_admin,
           COALESCE(sp.is_admin, false) AS self_is_admin
    FROM (
      SELECT user_a_id AS user_id, user_b_id AS other_id, admin_notes FROM public.matches
      UNION ALL
      SELECT user_b_id AS user_id, user_a_id AS other_id, admin_notes FROM public.matches
    ) x
    LEFT JOIN public.profiles p  ON p.id  = x.other_id
    LEFT JOIN public.profiles sp ON sp.id = x.user_id
  ) m
  GROUP BY m.user_id
),

rec AS (
  SELECT mc.user_id,
         COALESCE(mc.free_credits, 0)     AS free_credits,
         COALESCE(mc.premium_credits, 0)  AS premium_credits,
         COALESCE(mc.balance, 0)          AS balance,
         COALESCE(mc.lifetime_earned, 0)  AS lifetime_earned,
         COALESCE(pr.is_admin, false)          AS is_admin,
         COALESCE(pr.is_test_account, false)   AS is_test_account,
         COALESCE(pr.account_status, 'unknown') AS account_status,
         COALESCE(t.rows_debit, 0)        AS ledgered_debits_rows,
         COALESCE(t.negative, 0)          AS ledgered_debits,
         -- model 1: inflow from the authoritative ledgers, minus recorded outflow
         (COALESCE(g.c,0) + COALESCE(r.c,0) + COALESCE(t.positive,0) - COALESCE(t.negative,0))
           - COALESCE(mc.balance,0)                                        AS shortfall_ledgers,
         -- model 2: lifetime_earned, minus recorded outflow
         (COALESCE(mc.lifetime_earned,0) - COALESCE(t.negative,0))
           - COALESCE(mc.balance,0)                                        AS shortfall_lifetime,
         COALESCE(m.matches_total,0)                        AS matches_total,
         COALESCE(m.matches_with_admin,0)                   AS matches_with_admin,
         COALESCE(m.matches_ordinary,0)                     AS matches_ordinary,
         COALESCE(m.matches_admin_delegate_shape,0)         AS admin_delegate_matches,
         COALESCE(m.matches_ordinary_delegate_shape,0)      AS ordinary_delegate_matches,
         (COALESCE(mc.balance,0) <> COALESCE(mc.free_credits,0) + COALESCE(mc.premium_credits,0)) AS invariant_broken
  FROM public.meeting_credits mc
  LEFT JOIN grants  g  ON g.user_id  = mc.user_id
  LEFT JOIN refills r  ON r.user_id  = mc.user_id
  LEFT JOIN txn     t  ON t.user_id  = mc.user_id
  LEFT JOIN mp      m  ON m.user_id  = mc.user_id
  LEFT JOIN public.profiles pr ON pr.id = mc.user_id
),

-- ── the six populations ────────────────────────────────────────────────────────────────────────
cls AS (
  SELECT r.*,
    CASE
      -- (5) arithmetic is internally inconsistent: judge nothing derived from balance until this
      --     is understood. A NEGATIVE balance lands here, and so does any broken invariant.
      WHEN r.invariant_broken OR r.balance < 0 OR r.free_credits < 0 OR r.premium_credits < 0
        THEN '5_inconsistent_balance_state'
      WHEN r.shortfall_ledgers <= 0 AND r.shortfall_lifetime <= 0 THEN '0_no_shortfall'
      -- the two independent inflow models disagree: the NUMBER itself is untrustworthy
      WHEN r.shortfall_ledgers <> r.shortfall_lifetime THEN '4_ambiguous_manual_review'
      -- (2) the administrator's own deductions from operational connections
      WHEN r.is_admin AND r.admin_delegate_matches > 0
       AND r.shortfall_ledgers <= r.admin_delegate_matches THEN '2_admin_operational_deduction'
      -- (1) an ordinary member charged for a connection whose counterpart is the administrator
      WHEN NOT r.is_admin AND r.admin_delegate_matches > 0
       AND r.shortfall_ledgers <= r.admin_delegate_matches THEN '1_member_charged_for_admin_connection'
      -- (3) a real member-to-member connection: legitimate debit, only the RECORD is missing
      WHEN r.admin_delegate_matches = 0
       AND r.ordinary_delegate_matches > 0
       AND r.shortfall_ledgers <= r.ordinary_delegate_matches THEN '3_legitimate_missing_record'
      ELSE '4_ambiguous_manual_review'
    END AS population,
    -- Reported SEPARATELY rather than mixed into member recovery. Their accounting state may still
    -- need correcting for ledger integrity, but they are not an email or reactivation audience.
    CASE
      WHEN COALESCE(pr2.is_test_account, false) THEN 'test_account'
      WHEN COALESCE(pr2.account_status, '') <> 'active' THEN 'inactive_or_deactivated'
      ELSE 'active_member'
    END AS account_class
  FROM rec r
  LEFT JOIN public.profiles pr2 ON pr2.id = r.user_id
),

a AS (
  SELECT 1 AS sort, 'A. populations (aggregate only)' AS section,
         population || ' / ' || account_class AS metric,
         count(*)::text AS value, SUM(GREATEST(shortfall_ledgers, 0))::text AS credits,
         NULL::uuid AS user_id, NULL::int AS shortfall, NULL::int AS balance,
         NULL::int AS admin_matches, NULL::int AS ordinary_matches, NULL::text AS pop
  FROM cls GROUP BY population, account_class
),
a2 AS (
  SELECT 2, 'B. cross-checks', k, v, NULL::text, NULL::uuid, NULL::int, NULL::int, NULL::int, NULL::int, NULL::text
  FROM (VALUES
    ('accounts with credits',                       (SELECT count(*)::text FROM rec)),
    ('accounts where the two inflow models DISAGREE',(SELECT count(*)::text FROM rec WHERE shortfall_ledgers <> shortfall_lifetime)),
    ('total shortfall (ledger model)',              (SELECT COALESCE(SUM(shortfall_ledgers),0)::text FROM rec WHERE shortfall_ledgers > 0)),
    ('total shortfall (lifetime model)',            (SELECT COALESCE(SUM(shortfall_lifetime),0)::text FROM rec WHERE shortfall_lifetime > 0)),
    ('debit rows in credit_transactions, all time', (SELECT count(*)::text FROM public.credit_transactions WHERE amount < 0)),
    ('administrator accounts',                      (SELECT count(*)::text FROM public.profiles WHERE is_admin IS TRUE)),
    ('matches with an administrator participant',   (SELECT count(*)::text FROM public.matches m
                                                     WHERE EXISTS (SELECT 1 FROM public.profiles p
                                                                   WHERE p.id IN (m.user_a_id, m.user_b_id) AND p.is_admin IS TRUE)))
  ) v(k, v)
),

-- ══ SECTION C — STORED-STATE INTEGRITY. Aggregate. Run this FIRST: any non-zero here means a
--    number derived from balance cannot be trusted for the accounts concerned. ═════════════════
c0 AS (
  SELECT 3, 'C. stored-state integrity', k, v, NULL::text, NULL::uuid, NULL::int, NULL::int, NULL::int, NULL::int, NULL::text
  FROM (VALUES
    ('balance BELOW ZERO',            (SELECT count(*)::text FROM public.meeting_credits WHERE COALESCE(balance,0) < 0)),
    ('free_credits BELOW ZERO',       (SELECT count(*)::text FROM public.meeting_credits WHERE COALESCE(free_credits,0) < 0)),
    ('premium_credits BELOW ZERO',    (SELECT count(*)::text FROM public.meeting_credits WHERE COALESCE(premium_credits,0) < 0)),
    ('balance <> free + premium',     (SELECT count(*)::text FROM public.meeting_credits
                                       WHERE COALESCE(balance,0) <> COALESCE(free_credits,0) + COALESCE(premium_credits,0))),
    ('most negative balance observed',(SELECT COALESCE(MIN(balance),0)::text FROM public.meeting_credits)),
    ('largest invariant drift observed',
                                      (SELECT COALESCE(MAX(ABS(COALESCE(balance,0) - COALESCE(free_credits,0) - COALESCE(premium_credits,0))),0)::text
                                       FROM public.meeting_credits))
  ) v(k, v)
),

-- ══ SECTION D — accounts, for the refund manifest. user_id only. ══════════════════════════════
b AS (
  SELECT 4, 'D. accounts', account_class, NULL::text, NULL::text,
         user_id, shortfall_ledgers, balance, admin_delegate_matches, ordinary_delegate_matches, population
  FROM cls
  WHERE population <> '0_no_shortfall'
),

-- ══ SECTION E — what to do with each population ═══════════════════════════════════════════════
c AS (
  SELECT 5, 'E. disposition', k, v, NULL::text, NULL::uuid, NULL::int, NULL::int, NULL::int, NULL::int, NULL::text
  FROM (VALUES
    ('1_member_charged_for_admin_connection', 'REFUND. An ordinary member was charged for a connection whose counterpart is the administrator.'),
    ('2_admin_operational_deduction',         'REFUND, reported separately. The administrator was charged for operating the platform.'),
    ('3_legitimate_missing_record',           'DO NOT REFUND. A real member-to-member connection was charged; only the ledger row is missing. Backfill the record.'),
    ('4_ambiguous_manual_review',             'DO NOT bulk-refund. The two inflow models disagree, or the shortfall exceeds what matches explain.'),
    ('5_inconsistent_balance_state',          'INVESTIGATE FIRST. Negative or non-additive stored state; no balance-derived number is trustworthy here.'),
    ('account_class: test_account',           'Correct the accounting if ledger integrity requires it. Never email, never reactivate.'),
    ('account_class: inactive_or_deactivated','Correct the accounting if ledger integrity requires it. Never email, never reactivate.')
  ) v(k, v)
)

SELECT section, metric, value, credits, user_id,
       shortfall AS shortfall_credits, balance,
       admin_matches AS admin_participant_matches,
       ordinary_matches AS ordinary_matches,
       pop AS population
FROM (
  SELECT * FROM a UNION ALL SELECT * FROM a2 UNION ALL SELECT * FROM c0
  UNION ALL SELECT * FROM b UNION ALL SELECT * FROM c
) t(sort, section, metric, value, credits, user_id, shortfall, balance, admin_matches, ordinary_matches, pop)
ORDER BY sort, pop NULLS FIRST, shortfall DESC NULLS LAST, metric;
