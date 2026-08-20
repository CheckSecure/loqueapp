-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- PAST-MISUSE INDICATORS FOR public.consume_credits_and_create_match
--
-- STRICTLY READ-ONLY. SELECT and CTEs only. No INSERT/UPDATE/DELETE/DDL, no mutating or VOLATILE
-- function calls, no advisory locks, no SET. Safe to run against production.
--
-- AGGREGATE-ONLY BY CONSTRUCTION. Every output cell is a count, a ratio or a calendar date. No
-- names, no emails, no user ids, no match ids, no conversation ids, no free-text metadata. You
-- cannot identify a member from this output, which is the point: it answers "was this abused" and
-- deliberately cannot answer "by whom". If a section returns a non-zero count you must escalate to
-- a scoped, identifier-bearing follow-up query, deliberately and separately.
--
-- READ THE `confidence` COLUMN. `PROVABLE` means the row is a structural impossibility under the
-- intended flow - it cannot occur if every match went through mutual consent. `SUSPICIOUS` means
-- the row has a legitimate explanation as well as an illegitimate one, and volume or timing is what
-- distinguishes them. Do not report a SUSPICIOUS count as evidence of abuse.
--
-- ONE KNOWN CONFOUND, STATED UP FRONT: it is not documented whether the delegate writes a
-- credit_transactions ledger row when it charges a member. If it never did, section F will show a
-- large deficit for entirely innocent reasons. Establish the baseline before interpreting it:
-- compare the deficit's shape BEFORE and AFTER the exposure window rather than its absolute size.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

WITH
-- Canonical member pair per match, so direction can never double-count. Ids stay INSIDE the CTEs
-- and never reach the output.
m AS (
  SELECT id,
         LEAST(user_a_id, user_b_id)    AS lo,
         GREATEST(user_a_id, user_b_id) AS hi,
         user_a_id, user_b_id, created_at, admin_facilitated
  FROM public.matches
),
-- Consent evidence, reduced to one row per canonical pair.
ir AS (
  SELECT LEAST(requester_id, target_user_id)    AS lo,
         GREATEST(requester_id, target_user_id) AS hi,
         count(*) FILTER (WHERE requester_id = LEAST(requester_id, target_user_id)
                            AND status IN ('approved','accepted')) AS consent_lo,
         count(*) FILTER (WHERE requester_id = GREATEST(requester_id, target_user_id)
                            AND status IN ('approved','accepted')) AS consent_hi,
         count(*) AS any_rows
  FROM public.intro_requests
  GROUP BY 1, 2
),
conv AS (
  SELECT match_id, count(*) AS n FROM public.conversations GROUP BY 1
),

-- ── A. VOLUME OVER TIME ────────────────────────────────────────────────────────────────────────
-- The exposure window analysis. A day on which matches spiked far above the surrounding baseline
-- is the single strongest timing signal, because legitimate matches are gated by two members each
-- independently approving, which is a slow, rate-limited process.
a AS (
  SELECT 'A. matches per day' AS section,
         to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS indicator,
         count(*)::text AS metric,
         'CONTEXT' AS confidence
  FROM m
  GROUP BY 1, 2
),

-- ── B. SELF-MATCHES ────────────────────────────────────────────────────────────────────────────
-- PROVABLE. No consent path can pair a member with themselves. The hardened wrapper refuses it
-- outright; the raw delegate, called directly, does not obviously refuse it.
b AS (
  SELECT 'B. self-matches' AS section,
         'matches where both sides are the same member' AS indicator,
         count(*)::text AS metric,
         'PROVABLE' AS confidence
  FROM m WHERE user_a_id = user_b_id
),

-- ── C. MATCHES WITHOUT RECIPROCAL CONSENT EVIDENCE ─────────────────────────────────────────────
-- The core abuse signature. A match created through the intended flow is preceded by approvals in
-- BOTH directions. Split three ways because the three have very different meanings.
c AS (
  SELECT 'C. consent evidence' AS section, indicator, count(*)::text AS metric, confidence
  FROM (
    SELECT CASE
             WHEN ir.lo IS NULL       THEN 'no introduction rows exist for the pair at all'
             WHEN ir.consent_lo = 0
              AND ir.consent_hi = 0   THEN 'introduction rows exist but NEITHER side ever consented'
             WHEN ir.consent_lo = 0
               OR ir.consent_hi = 0   THEN 'only ONE side ever consented'
             ELSE NULL
           END AS indicator,
           CASE WHEN ir.lo IS NULL OR (ir.consent_lo = 0 AND ir.consent_hi = 0)
                THEN 'PROVABLE' ELSE 'SUSPICIOUS' END AS confidence
    FROM m LEFT JOIN ir ON ir.lo = m.lo AND ir.hi = m.hi
    WHERE m.user_a_id <> m.user_b_id
  ) t
  WHERE indicator IS NOT NULL
  GROUP BY indicator, confidence
),
-- Historical note for the one-sided bucket: an admin-facilitated introduction is a legitimate way
-- to reach a match without two member approvals, so that bucket is SUSPICIOUS, not PROVABLE. The
-- admin_facilitated split in section G is what separates them.

-- ── D. CONVERSATIONS WITHOUT A VALID MATCH ─────────────────────────────────────────────────────
-- PROVABLE. The delegate creates exactly one conversation per match it creates. An orphan means
-- either a partial write that was not rolled back, or a conversation created some other way.
d AS (
  SELECT 'D. orphaned conversations' AS section,
         'conversations whose match_id has no matches row' AS indicator,
         count(*)::text AS metric,
         'PROVABLE' AS confidence
  FROM public.conversations cv
  WHERE NOT EXISTS (SELECT 1 FROM public.matches mm WHERE mm.id = cv.match_id)
),

-- ── E. MATCHES WITHOUT THE EXPECTED CONVERSATION COUNT ─────────────────────────────────────────
-- PROVABLE in both directions. Zero means the match was created without the delegate's conversation
-- insert - i.e. not by this function, or by an interrupted run. More than one means the pair was
-- put through match creation repeatedly.
e AS (
  SELECT 'E. conversation cardinality' AS section, indicator, count(*)::text AS metric, 'PROVABLE' AS confidence
  FROM (
    SELECT CASE WHEN COALESCE(conv.n, 0) = 0 THEN 'matches with NO conversation'
                WHEN conv.n > 1              THEN 'matches with MORE THAN ONE conversation'
                ELSE NULL END AS indicator
    FROM m LEFT JOIN conv ON conv.match_id = m.id
  ) t
  WHERE indicator IS NOT NULL
  GROUP BY indicator
),

-- ── F. CREDIT RECONCILIATION ───────────────────────────────────────────────────────────────────
-- Two independent checks.
--   F1 is PROVABLE: migration 052 maintains balance = free_credits + premium_credits. A row that
--      violates it was written by something that did not respect the invariant.
--   F2 is SUSPICIOUS and carries the confound described in the header. Read its SHAPE, not its size.
f1 AS (
  SELECT 'F. credit reconciliation' AS section,
         'credit rows violating balance = free + premium' AS indicator,
         count(*)::text AS metric,
         'PROVABLE' AS confidence
  FROM public.meeting_credits
  WHERE COALESCE(balance, 0) <> COALESCE(free_credits, 0) + COALESCE(premium_credits, 0)
),
f2 AS (
  SELECT 'F. credit reconciliation' AS section,
         'ledgered deductions minus 2x matches (see header confound)' AS indicator,
         ((SELECT count(*) FROM public.credit_transactions WHERE amount < 0)
          - (SELECT 2 * count(*) FROM m))::text AS metric,
         'SUSPICIOUS' AS confidence
),

-- ── G. DUPLICATE PAIRS AND admin_facilitated SHAPE ─────────────────────────────────────────────
-- G1 is PROVABLE: the delegate returns duplicate_match rather than creating a second match, so two
-- matches for one canonical pair means the guard was bypassed or raced.
g1 AS (
  SELECT 'G. pair and flag anomalies' AS section,
         'canonical member pairs holding MORE THAN ONE match' AS indicator,
         count(*)::text AS metric,
         'PROVABLE' AS confidence
  FROM (SELECT lo, hi FROM m GROUP BY lo, hi HAVING count(*) > 1) x
),
-- G2 is CONTEXT: admin_facilitated is the legitimate explanation for a one-sided-consent match, so
-- its distribution is what makes section C readable. NULL is its own bucket - the delegate defaults
-- it to false, so a NULL was written by something else.
g2 AS (
  SELECT 'G. pair and flag anomalies' AS section,
         'admin_facilitated = ' || COALESCE(admin_facilitated::text, 'NULL') AS indicator,
         count(*)::text AS metric,
         'CONTEXT' AS confidence
  FROM m GROUP BY admin_facilitated
),
-- G3 is PROVABLE: an admin_facilitated match with no introduction row at all had no artefact of any
-- kind behind it - not a member approval, not an admin action against a real introduction.
g3 AS (
  SELECT 'G. pair and flag anomalies' AS section,
         'admin_facilitated matches with NO introduction rows' AS indicator,
         count(*)::text AS metric,
         'PROVABLE' AS confidence
  FROM m LEFT JOIN ir ON ir.lo = m.lo AND ir.hi = m.hi
  WHERE m.admin_facilitated IS TRUE AND ir.lo IS NULL
),

-- ── H. HEADLINE TOTALS ─────────────────────────────────────────────────────────────────────────
h AS (
  SELECT 'H. totals' AS section, indicator, metric, 'CONTEXT' AS confidence FROM (
    SELECT 'matches, all time' AS indicator, (SELECT count(*) FROM m)::text AS metric
    UNION ALL SELECT 'conversations, all time', (SELECT count(*) FROM public.conversations)::text
    UNION ALL SELECT 'earliest match date',  COALESCE((SELECT to_char(min(created_at),'YYYY-MM-DD') FROM m), 'none')
    UNION ALL SELECT 'latest match date',    COALESCE((SELECT to_char(max(created_at),'YYYY-MM-DD') FROM m), 'none')
  ) t
)

SELECT section, indicator, metric, confidence
FROM (
  SELECT * FROM h
  UNION ALL SELECT * FROM b
  UNION ALL SELECT * FROM c
  UNION ALL SELECT * FROM d
  UNION ALL SELECT * FROM e
  UNION ALL SELECT * FROM f1
  UNION ALL SELECT * FROM f2
  UNION ALL SELECT * FROM g1
  UNION ALL SELECT * FROM g2
  UNION ALL SELECT * FROM g3
  UNION ALL SELECT * FROM a
) final
ORDER BY section, indicator;
