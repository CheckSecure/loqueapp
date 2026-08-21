-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- VISIBLE INTRODUCTION CARDS — ARE THEIR TARGETS ACTUALLY ELIGIBLE?
--
-- STRICTLY READ-ONLY. One statement, SELECT + CTEs only. No DML, DDL, locks, temporary objects,
-- dynamic SQL or mutating calls. AGGREGATE OUTPUT ONLY — every cell is a label or a count. No
-- UUIDs, no names, no emails.
--
-- ─── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────
-- A member reported "This member is no longer active" when expressing interest in a target that
-- production proves IS active. The cause was a privilege change being reported as member state:
-- migration 058 revoked authenticated SELECT on public.profiles, the gate read that table with the
-- caller's client, discarded the error, and treated the resulting NULL as "deactivated".
--
-- That was a code defect, and it is fixed. This query answers the SEPARATE question the incident
-- raised and could not answer: are there members holding VISIBLE cards whose targets are genuinely
-- not eligible? Those are real dead ends — a card the member can see and act on, that can never
-- finalize. This counts them without naming anyone.
--
-- Section C also looks for structurally malformed reciprocal pairs, because a card whose pair is
-- terminal is another kind of dead end: visible, occupying capacity, and unactionable.
--
-- READ IT AS: eligible_target is the healthy population. Everything else is a card that should
-- probably not be on someone's screen.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

WITH
-- Every directional card a member can currently SEE and act on.
visible AS (
  SELECT ir.id, ir.requester_id, ir.target_user_id, ir.pair_id
  FROM public.intro_requests ir
  WHERE ir.status = 'suggested'
),
-- The target's eligibility, using the SAME properties the matching layer uses.
classified AS (
  SELECT
    CASE
      WHEN p.id IS NULL                              THEN 'target_missing'
      WHEN COALESCE(p.account_status, '') <> 'active' THEN 'target_inactive_or_deactivated'
      WHEN p.profile_complete IS NOT TRUE            THEN 'target_incomplete_profile'
      WHEN p.is_test_account IS TRUE                 THEN 'target_test_account'
      WHEN p.matching_paused IS TRUE                 THEN 'target_matching_paused'
      ELSE 'target_fully_eligible'
    END AS target_class,
    v.pair_id
  FROM visible v
  LEFT JOIN public.profiles p ON p.id = v.target_user_id
),

a AS (
  SELECT 1 AS sort, 'A. visible cards by target eligibility' AS section,
         target_class AS metric, count(*)::text AS value
  FROM classified GROUP BY target_class
),
a2 AS (
  SELECT 1, 'A. visible cards by target eligibility', 'ALL visible cards',
         (SELECT count(*)::text FROM visible)
),

-- ── B. the pair state a visible card is attached to ────────────────────────────────────────────
-- A reciprocal card should sit on an ACTIVE pair. Anything else is a card that survived its pair.
b AS (
  SELECT 2, 'B. visible cards by pair state', k, v FROM (
    SELECT COALESCE('pair_' || mp.status, 'pair_status_null') AS k, count(*)::text AS v
    FROM visible vv JOIN public.member_pairs mp ON mp.id = vv.pair_id
    GROUP BY mp.status
  ) x
),
b2 AS (
  SELECT 2, 'B. visible cards by pair state', k, v FROM (VALUES
    ('legacy card with NO pair_id (not reciprocal)',
      (SELECT count(*)::text FROM visible WHERE pair_id IS NULL)),
    ('card whose pair_id references no pair row',
      (SELECT count(*)::text FROM visible v
       WHERE v.pair_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.member_pairs mp WHERE mp.id = v.pair_id))),
    ('VISIBLE card on a NON-ACTIVE pair (dead end)',
      (SELECT count(*)::text FROM visible v JOIN public.member_pairs mp ON mp.id = v.pair_id
       WHERE COALESCE(mp.status, '') <> 'active'))
  ) y(k, v)
),

-- ── C. malformed reciprocal pairs ──────────────────────────────────────────────────────────────
-- A reciprocal pair is two directional rows. One row, three rows, or two rows in disagreeing
-- states are all structural corruption, and each one strands capacity.
pairrows AS (
  SELECT ir.pair_id,
         count(*)                                          AS n_rows,
         count(*) FILTER (WHERE ir.status = 'suggested')    AS n_visible,
         count(DISTINCT ir.status)                          AS n_distinct_status
  FROM public.intro_requests ir
  WHERE ir.pair_id IS NOT NULL
  GROUP BY ir.pair_id
),
c AS (
  SELECT 3, 'C. reciprocal pair shape', k, v FROM (VALUES
    ('pairs with exactly two directional rows (healthy shape)',
      (SELECT count(*)::text FROM pairrows WHERE n_rows = 2)),
    ('pairs with only ONE directional row (asymmetric)',
      (SELECT count(*)::text FROM pairrows WHERE n_rows = 1)),
    ('pairs with MORE than two directional rows',
      (SELECT count(*)::text FROM pairrows WHERE n_rows > 2)),
    ('pairs where exactly one side is still visible (one-sided visibility)',
      (SELECT count(*)::text FROM pairrows WHERE n_rows = 2 AND n_visible = 1)),
    ('pairs where both sides are visible (normal open pair)',
      (SELECT count(*)::text FROM pairrows WHERE n_rows = 2 AND n_visible = 2)),
    ('member_pairs rows with NO directional rows at all',
      (SELECT count(*)::text FROM public.member_pairs mp
       WHERE NOT EXISTS (SELECT 1 FROM public.intro_requests ir WHERE ir.pair_id = mp.id))),
    ('ACTIVE pairs holding zero visible cards',
      (SELECT count(*)::text FROM public.member_pairs mp
       WHERE mp.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM public.intro_requests ir
                         WHERE ir.pair_id = mp.id AND ir.status = 'suggested')))
  ) z(k, v)
),

-- ── D. how many MEMBERS are affected, not how many cards ───────────────────────────────────────
d AS (
  SELECT 4, 'D. members affected', k, v FROM (VALUES
    ('members holding at least one visible card',
      (SELECT count(DISTINCT requester_id)::text FROM visible)),
    ('members holding at least one INELIGIBLE-target visible card',
      (SELECT count(DISTINCT v.requester_id)::text
       FROM visible v LEFT JOIN public.profiles p ON p.id = v.target_user_id
       WHERE p.id IS NULL
          OR COALESCE(p.account_status,'') <> 'active'
          OR p.profile_complete IS NOT TRUE
          OR p.is_test_account IS TRUE
          OR p.matching_paused IS TRUE)),
    ('members whose visible cards are ALL ineligible (fully stranded)',
      (SELECT count(*)::text FROM (
         SELECT v.requester_id
         FROM visible v LEFT JOIN public.profiles p ON p.id = v.target_user_id
         GROUP BY v.requester_id
         HAVING count(*) FILTER (
           WHERE p.id IS NOT NULL
             AND COALESCE(p.account_status,'') = 'active'
             AND p.profile_complete IS TRUE
             AND p.is_test_account IS NOT TRUE
             AND p.matching_paused IS NOT TRUE) = 0
       ) s))
  ) w(k, v)
)

SELECT section, metric, value
FROM (
  SELECT * FROM a  UNION ALL SELECT * FROM a2 UNION ALL SELECT * FROM b
  UNION ALL SELECT * FROM b2 UNION ALL SELECT * FROM c UNION ALL SELECT * FROM d
) t(sort, section, metric, value)
ORDER BY sort, metric;
