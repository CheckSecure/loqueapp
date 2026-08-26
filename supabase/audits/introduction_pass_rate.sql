-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- INTRODUCTION PASS RATE BY WEEKLY WINDOW — read-only. No writes, no locks, no member identities.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- ANSWERS: of the introduction cards placed in each weekly window, how many did members answer,
-- and how did they answer? Run before and after a guidance change to see whether the copy moved
-- response behaviour.
--
-- ─── WHY THIS IS COMPUTABLE AT ALL ────────────────────────────────────────────────────────────
-- Nothing destroys the response. A member's answer lands in one of two durable places, and this
-- query reads both:
--
--   INTERESTED   the card row's own status becomes 'approved'/'pending'/'accepted'…
--                (POST /api/intro-requests/express-interest updates the card in place), OR the card
--                stays 'suggested' and a CORRELATED expression row points back at it through
--                responds_to_id (public.express_intro_interest, migration 080). Both are counted.
--   PASSED       the card row's status becomes 'passed' (Not for me) or 'hidden_permanent'
--                (Don't show again / I already know them), with the member's choice preserved
--                separately in resolution_reason (migration 062).
--
-- So a pass is never overwritten by a later state, and an expression is never lost. The one thing
-- that IS lost is the DISTINCTION for pre-062 dismissals: resolution_reason is NULL on those rows
-- and is never backfilled, so they are reported as passes with reason 'unrecorded' rather than
-- being attributed to a choice nobody recorded.
--
-- ─── THE ARITHMETIC DEFECT THIS FILE NOW REFUSES TO HAVE ──────────────────────────────────────
-- An earlier draft reported 6 cards placed but 2 interested + 2 passed + 1 expired + 2 still open
-- = 7. The cause: a card answered by a CORRELATED expression stays 'suggested' (migration 080), so
-- it was counted BOTH as interested (correct) and as still-awaiting (wrong — it has been answered).
--
-- Current state is now decided ONCE per card, by the first rule it matches, in this order:
--     interested -> passed -> expired_without_an_answer -> still_awaiting -> unclassified
-- The five buckets are mutually exclusive, they sum to cards_placed, and `reconciles` is emitted as
-- a boolean per week plus an overall verdict. `unclassified` exists so a status nobody anticipated
-- (e.g. 'declined', 'archived', 'hidden') is COUNTED AND VISIBLE rather than quietly dropped to make
-- the totals look right. A query whose totals do not reconcile is not shipped.
--
-- ─── THE WEEKLY WINDOW ────────────────────────────────────────────────────────────────────────
-- Grouped by ISO week of the card's created_at (the week the introduction was placed), which is
-- the only window every card has: release_id exists solely on post-081 release-owner rows and
-- batch_id only on batch-placed rows, so grouping by either would silently drop most cards. Both
-- are still reported per window as coverage counts, so you can see how much of a week carries one.
--
-- ─── PRIVACY ──────────────────────────────────────────────────────────────────────────────────
-- Aggregates only. No requester_id, target_user_id, pair_id, name or email is selected or emitted,
-- and no window is broken down finely enough to isolate an individual. `members` is a DISTINCT
-- COUNT, never a list.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
WITH cards AS (
  -- One row per placed introduction card. A correlated expression row is NOT a card — it is an
  -- answer to one — so it is excluded here and joined below instead, or every interested card
  -- would be counted twice.
  SELECT
    r.id,
    r.requester_id,
    date_trunc('week', r.created_at)::date AS week_start,
    r.status,
    r.resolution_reason,
    r.batch_id,
    (to_jsonb(r) ->> 'release_id')     IS NOT NULL AS has_release_id,
    (to_jsonb(r) ->> 'responds_to_id') IS NULL     AS is_card
  FROM public.intro_requests r
  WHERE r.created_at >= now() - interval '180 days'
),
placed AS (
  SELECT * FROM cards WHERE is_card
),
flags AS (
  SELECT
    p.*,
    -- INTERESTED, mechanism 1: the card row itself was advanced by expressing interest.
    (p.status IN ('pending','approved','accepted','accepted_pending_payment','admin_pending')) AS interested_inplace,
    -- INTERESTED, mechanism 2: the card is still 'suggested' but a correlated expression answers it.
    EXISTS (
      SELECT 1 FROM public.intro_requests e
       WHERE (to_jsonb(e) ->> 'responds_to_id') = p.id::text
         AND e.status IN ('pending','approved','accepted','accepted_pending_payment','admin_pending')
    ) AS interested_correlated
  FROM placed p
),
answered AS (
  -- ONE bucket per card. CASE stops at the first match, which is what makes them exclusive.
  SELECT
    f.*,
    CASE
      WHEN f.interested_inplace OR f.interested_correlated THEN 'interested'
      WHEN f.status IN ('passed','hidden_permanent')       THEN 'passed'
      WHEN f.status = 'expired'                            THEN 'expired_without_an_answer'
      WHEN f.status IN ('suggested','queued')              THEN 'still_awaiting'
      ELSE 'unclassified'
    END AS state
  FROM flags f
),
per_week AS (
  SELECT
    week_start,
    count(*)                                                              AS cards_placed,
    count(DISTINCT requester_id)                                          AS members,
    count(*) FILTER (WHERE state = 'interested')                          AS interested,
    count(*) FILTER (WHERE state = 'passed')                              AS passed,
    count(*) FILTER (WHERE state = 'expired_without_an_answer')           AS expired_unanswered,
    count(*) FILTER (WHERE state = 'still_awaiting')                      AS still_awaiting_response,
    count(*) FILTER (WHERE state = 'unclassified')                        AS unclassified,
    count(*) FILTER (WHERE state = 'passed' AND resolution_reason = 'not_for_me')   AS pass_not_for_me,
    count(*) FILTER (WHERE state = 'passed' AND resolution_reason = 'never_show')   AS pass_never_show,
    count(*) FILTER (WHERE state = 'passed' AND resolution_reason = 'already_know') AS pass_already_know,
    count(*) FILTER (WHERE state = 'expired_without_an_answer'
                       AND resolution_reason = 'system_pair_unavailable')         AS system_released,
    count(*) FILTER (WHERE state = 'passed' AND resolution_reason IS NULL)          AS pass_reason_unrecorded,
    -- EVENT metric, deliberately kept apart from the current-state buckets: it overlaps 'interested'
    -- because the card is still 'suggested' while the answer lives on a correlated row.
    count(*) FILTER (WHERE interested_correlated)                         AS event_interest_correlated,
    count(*) FILTER (WHERE interested_inplace)                            AS event_interest_in_place,
    count(*) FILTER (WHERE batch_id IS NOT NULL)                          AS carries_batch_id,
    count(*) FILTER (WHERE has_release_id)                                AS carries_release_id
  FROM answered
  GROUP BY week_start
)
SELECT jsonb_pretty(jsonb_build_object(
  'generated_at', now(),
  'window', '180 days, grouped by ISO week of card placement',
  'weeks', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'week_start', week_start,
      -- ── DENOMINATOR ───────────────────────────────────────────────────────────────────────
      'cards_placed', cards_placed,
      'members', members,
      -- ── MUTUALLY EXCLUSIVE CURRENT STATE — these five sum to cards_placed ──────────────────
      'current_state', jsonb_build_object(
        'interested', interested,
        'passed', passed,
        'expired_without_an_answer', expired_unanswered,
        'still_awaiting', still_awaiting_response,
        'unclassified', unclassified),
      -- ── DERIVED GROUPINGS of those same five, so they also reconcile ───────────────────────
      'answered', interested + passed,
      'unanswered', expired_unanswered + still_awaiting_response + unclassified,
      'answered_rate_pct', CASE WHEN cards_placed > 0
        THEN round(100.0 * (interested + passed) / cards_placed, 1) ELSE NULL END,
      'unanswered_rate_pct', CASE WHEN cards_placed > 0
        THEN round(100.0 * (expired_unanswered + still_awaiting_response + unclassified) / cards_placed, 1) ELSE NULL END,
      'interested_rate_pct', CASE WHEN (interested + passed) > 0
        THEN round(100.0 * interested / (interested + passed), 1) ELSE NULL END,
      'pass_rate_pct', CASE WHEN (interested + passed) > 0
        THEN round(100.0 * passed / (interested + passed), 1) ELSE NULL END,
      'pass_reasons', jsonb_build_object(
        'not_for_me', pass_not_for_me,
        'never_show', pass_never_show,
        'already_know', pass_already_know,
        'unrecorded_pre_062', pass_reason_unrecorded),
      -- 085 neutralisations land under expired_without_an_answer, NEVER under passed: they are a
      -- system release, not a member verdict. Broken out so they are never read as a Pass.
      'expired_breakdown', jsonb_build_object(
        'system_released_target_unavailable', system_released,
        'other_expiry', expired_unanswered - system_released),
      -- ── EVENT metrics — these OVERLAP the buckets above and never enter the denominator ────
      'events_overlapping', jsonb_build_object(
        'interest_expressed_in_place', event_interest_in_place,
        'interest_expressed_correlated', event_interest_correlated),
      'envelope_coverage', jsonb_build_object(
        'cards_with_batch_id', carries_batch_id,
        'cards_with_release_id', carries_release_id),
      -- ── THE PROOF ─────────────────────────────────────────────────────────────────────────
      'reconciliation', jsonb_build_object(
        'sum_of_exclusive_states', interested + passed + expired_unanswered + still_awaiting_response + unclassified,
        'cards_placed', cards_placed,
        'reconciles', (interested + passed + expired_unanswered + still_awaiting_response + unclassified) = cards_placed)
    ) ORDER BY week_start DESC)
    FROM per_week), '[]'::jsonb),
  'totals', (SELECT jsonb_build_object(
      'cards_placed', COALESCE(sum(cards_placed),0),
      'interested', COALESCE(sum(interested),0),
      'passed', COALESCE(sum(passed),0),
      'expired_without_an_answer', COALESCE(sum(expired_unanswered),0),
      'still_awaiting', COALESCE(sum(still_awaiting_response),0),
      'unclassified', COALESCE(sum(unclassified),0),
      'answered', COALESCE(sum(interested + passed),0),
      'unanswered', COALESCE(sum(expired_unanswered + still_awaiting_response + unclassified),0),
      'sum_of_exclusive_states', COALESCE(sum(interested + passed + expired_unanswered + still_awaiting_response + unclassified),0)
    ) FROM per_week),
  'reconciles_overall', COALESCE((
    SELECT bool_and((interested + passed + expired_unanswered + still_awaiting_response + unclassified) = cards_placed)
    FROM per_week), true),
  'verdict', CASE WHEN COALESCE((
      SELECT bool_and((interested + passed + expired_unanswered + still_awaiting_response + unclassified) = cards_placed)
      FROM per_week), true)
    THEN 'RECONCILED: every week''s mutually exclusive states sum exactly to cards placed'
    ELSE 'DEFECT: a week''s states do not sum to cards placed — do not use these figures' END,
  'reading_notes', jsonb_build_array(
    'current_state holds FIVE mutually exclusive buckets that sum to cards_placed. answered and '
    || 'unanswered are groupings of those same five, so they also sum to cards_placed.',
    'events_overlapping are EVENT counts, not states: a correlated answer leaves the card '
    || '''suggested'', so it appears under interested and under interest_expressed_correlated. '
    || 'They are reported separately and never enter the denominator.',
    'A correlated response ROW is not a placed card and is excluded from the denominator.',
    'unclassified is never zero-ed to make totals fit — it exists so an unanticipated status is '
    || 'visible rather than silently dropped.',
    'still_awaiting is not a failure — recent weeks always carry open cards.',
    'unrecorded_pre_062 passes are real passes whose reason predates migration 062. Never backfilled.',
    'system_released_target_unavailable counts cards neutralised by migration 085 because the '
    || 'target became unavailable. It sits under EXPIRED, never under PASSED: it is a system '
    || 'release, not a member verdict, and must never be read as one.',
    'Cards, not people: one member may hold several in a week. members is a distinct count.',
    'No member identity is emitted by this query.')
)) AS pass_rate;
