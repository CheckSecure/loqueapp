-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- UNAVAILABLE-TARGET CENSUS — read-only. How many live cards point at somebody unanswerable?
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- No writes, no locks, NO IDENTITIES: aggregate counts only, never a requester_id, target_user_id,
-- pair_id, name or email.
--
-- MUTUALLY EXCLUSIVE by construction. Each 'suggested' card is placed in EXACTLY ONE bucket by the
-- first rule it matches, in the order below, so the buckets sum to suggested_total and the sum is
-- asserted in the output. A card can be several kinds of unavailable at once; a census that counted
-- it once per kind would total more than it started with (the arithmetic defect this file avoids).
--
-- ORDER, and why: blocking first because it is the only category that must never be RENDERED at
-- all; then the target's own availability from hardest to softest; then pair malformation; then the
-- genuinely actionable remainder.
WITH classified AS (
  SELECT
    CASE
      WHEN EXISTS (SELECT 1 FROM public.blocked_users bu
                    WHERE (bu.user_id = s.requester_id     AND bu.blocked_user_id = s.target_user_id)
                       OR (bu.user_id = s.target_user_id   AND bu.blocked_user_id = s.requester_id))
        THEN 'blocked_either_direction'
      WHEN t.id IS NULL                        THEN 'target_missing'
      WHEN t.account_status <> 'active'        THEN 'target_inactive'
      WHEN t.is_test_account IS TRUE           THEN 'target_test_account'
      WHEN t.matching_paused IS TRUE           THEN 'target_matching_paused'
      WHEN t.profile_complete IS NOT TRUE      THEN 'target_profile_incomplete'
      -- a pair card whose counterpart row does not exist is a malformed/orphaned pair
      WHEN s.pair_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM public.intro_requests o
              WHERE o.pair_id = s.pair_id AND o.id <> s.id
                AND o.responds_to_id IS NULL          -- a response row is not a counterpart card
                AND o.requester_id = s.target_user_id AND o.target_user_id = s.requester_id)
        THEN 'orphaned_pair_row'
      WHEN s.requester_id IS NULL OR s.target_user_id IS NULL OR s.requester_id = s.target_user_id
        THEN 'malformed_row'
      ELSE 'otherwise_actionable'
    END AS bucket
    , (s.capacity_released_at IS NULL) AS consumes_a_visible_slot
  FROM public.intro_requests s
  LEFT JOIN public.profiles t ON t.id = s.target_user_id
  WHERE s.status = 'suggested'
    AND s.responds_to_id IS NULL      -- PLACEMENT cards only; a correlated response is not a card
),
counts AS (SELECT bucket, count(*) AS n FROM classified GROUP BY bucket),
capacity AS (
  -- THE point of the second review blocker: how many visible slots are being eaten by rows nobody
  -- can act on. Counted by the exact authority the four writers use.
  SELECT
    count(*) FILTER (WHERE consumes_a_visible_slot) AS slots_consumed_total,
    count(*) FILTER (WHERE consumes_a_visible_slot AND bucket <> 'otherwise_actionable')
      AS slots_consumed_by_unavailable
  FROM classified
),
total  AS (SELECT count(*) AS n FROM classified),
b AS (
  SELECT
    COALESCE((SELECT n FROM counts WHERE bucket='blocked_either_direction'),0)  AS blocked_either_direction,
    COALESCE((SELECT n FROM counts WHERE bucket='target_missing'),0)            AS target_missing,
    COALESCE((SELECT n FROM counts WHERE bucket='target_inactive'),0)           AS target_inactive,
    COALESCE((SELECT n FROM counts WHERE bucket='target_test_account'),0)       AS target_test_account,
    COALESCE((SELECT n FROM counts WHERE bucket='target_matching_paused'),0)    AS target_matching_paused,
    COALESCE((SELECT n FROM counts WHERE bucket='target_profile_incomplete'),0) AS target_profile_incomplete,
    COALESCE((SELECT n FROM counts WHERE bucket='orphaned_pair_row'),0)         AS orphaned_pair_row,
    COALESCE((SELECT n FROM counts WHERE bucket='malformed_row'),0)             AS malformed_row,
    COALESCE((SELECT n FROM counts WHERE bucket='otherwise_actionable'),0)      AS otherwise_actionable
)
SELECT jsonb_pretty(jsonb_build_object(
  'generated_at', now(),
  'suggested_total', (SELECT n FROM total),
  'buckets_mutually_exclusive', (SELECT to_jsonb(b) FROM b),
  'unavailable_total', (SELECT blocked_either_direction + target_missing + target_inactive
                             + target_test_account + target_matching_paused + target_profile_incomplete
                             + orphaned_pair_row + malformed_row FROM b),
  'reconciles', (SELECT (blocked_either_direction + target_missing + target_inactive
                       + target_test_account + target_matching_paused + target_profile_incomplete
                       + orphaned_pair_row + malformed_row + otherwise_actionable) FROM b)
                = (SELECT n FROM total),
  'visible_capacity', jsonb_build_object(
    'slots_consumed_total', (SELECT slots_consumed_total FROM capacity),
    'slots_consumed_by_unavailable', (SELECT slots_consumed_by_unavailable FROM capacity),
    'note', 'RAW rows only. Since migration 085 these no longer cost anyone an introduction — the '
         || 'writers compute USABLE capacity and ignore them — so this is a tidiness figure, not a '
         || 'lost-allocation figure. It sizes what the cleanup artifact would neutralise.'),
  'reading_notes', jsonb_build_array(
    'Each card is counted ONCE, by the first rule it matches, in the order listed in this file.',
    'A card can be unavailable in several ways; the bucket names the reason it was FIRST caught.',
    'unavailable_total is the population supabase/repairs/unavailable_cards_release.PROPOSED.sql '
    || 'would neutralise, if the operator chooses to run it.',
    'No member identity is emitted by this query.')
)) AS census;
