-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- MONTHLY REFILL AUDIT — READ-ONLY. ONE statement. AGGREGATE ONLY. NO identities.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Answers whether the anniversary-cycle refill (migration 053) is actually running, for whom, and
-- with what result. It CHANGES NOTHING and emits no user id, name, email or per-member timestamp.
--
-- HOW THE REFILL WORKS TODAY, for reading these numbers:
--   • One cycle row per member, keyed to the monthly anniversary of signup, in UTC dates.
--   • /api/cron/daily-refill runs 05:00 UTC daily and claims rows whose next_refill_on <= today.
--   • apply_credit_refill REPLACES free_credits with the tier allowance and PRESERVES premium.
--     Unused included credits therefore do NOT roll over.
--   • Allowances are DB-authoritative: free 3, professional 10, executive 20, founding 15.
--   • Unknown/inconsistent tiers are PARKED as status='needs_review' and granted nothing.
--
-- DEPLOYED STATE IS DETECTED, NOT ASSUMED. The refill functions are read from pg_proc below rather
-- than inferred from migration headers, which can be stale — migration 072's header still says
-- "NOT YET APPLIED" although 072 and 073 were applied and verified in production.
WITH have AS (
  SELECT to_regclass('public.membership_credit_cycles') IS NOT NULL AS has_cycles,
         to_regclass('public.credit_refills')           IS NOT NULL AS has_refills
),
prof AS (
  SELECT p.id, p.is_test_account, p.is_admin, p.account_status,
         COALESCE(NULLIF(btrim(COALESCE(p.subscription_tier,'')),''),'free') AS sub_tier,
         p.is_founding_member, p.founding_member_expires_at
  FROM public.profiles p
),
eligible AS (
  SELECT p.*,
    CASE WHEN p.is_founding_member IS TRUE
           AND (p.founding_member_expires_at IS NULL OR p.founding_member_expires_at >= now())
         THEN 'founding' ELSE p.sub_tier END AS effective_tier
  FROM prof p WHERE p.is_test_account IS NOT TRUE
),
allowance AS (
  SELECT e.*, CASE e.effective_tier
                WHEN 'free' THEN 3 WHEN 'professional' THEN 10
                WHEN 'executive' THEN 20 WHEN 'founding' THEN 15 ELSE NULL END AS included
  FROM eligible e
),
cyc AS (
  SELECT c.user_id, c.anchor_day, c.next_refill_on, c.last_refill_on, c.last_tier,
         c.claimed_tier, c.status, c.lease_expires_at
  FROM public.membership_credit_cycles c WHERE (SELECT has_cycles FROM have)
),
j AS (
  SELECT a.*, c.next_refill_on, c.last_refill_on, c.status AS cycle_status,
         c.last_tier, c.lease_expires_at, (c.user_id IS NULL) AS no_cycle_row
  FROM allowance a LEFT JOIN cyc c ON c.user_id = a.id
)
SELECT jsonb_pretty(jsonb_build_object(
  'generated_at', now(),
  'today_utc', CURRENT_DATE,
  'tables_present', (SELECT to_jsonb(h) FROM have h),
  'expected_eligible_by_tier', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'effective_tier', effective_tier,
      'members', n,
      'db_allowance', COALESCE(included::text, '(UNKNOWN TIER — parked, granted nothing)'),
      'with_cycle_row', with_cycle) ORDER BY effective_tier)
    FROM (SELECT effective_tier, included, count(*) n,
                 count(*) FILTER (WHERE NOT no_cycle_row) with_cycle
          FROM j GROUP BY effective_tier, included) x), '[]'::jsonb),
  'cycle_status', CASE WHEN (SELECT has_cycles FROM have) THEN
    jsonb_build_object(
      'by_status', COALESCE((SELECT jsonb_object_agg(COALESCE(cycle_status,'(null)'), n)
        FROM (SELECT cycle_status, count(*) n FROM j WHERE NOT no_cycle_row GROUP BY 1) a), '{}'::jsonb),
      'members_with_no_cycle_row', (SELECT count(*) FROM j WHERE no_cycle_row),
      'due_today_or_earlier',      (SELECT count(*) FROM j WHERE next_refill_on <= CURRENT_DATE),
      'overdue_by_1_to_7_days',    (SELECT count(*) FROM j WHERE next_refill_on BETWEEN CURRENT_DATE-7 AND CURRENT_DATE-1),
      'overdue_by_more_than_7',    (SELECT count(*) FROM j WHERE next_refill_on < CURRENT_DATE-7),
      'leases_currently_held',     (SELECT count(*) FROM j WHERE lease_expires_at IS NOT NULL),
      'stale_leases_expired',      (SELECT count(*) FROM j WHERE lease_expires_at IS NOT NULL AND lease_expires_at < now()))
    ELSE '"unavailable: membership_credit_cycles does not exist"'::jsonb END,
  'recent_refills', CASE WHEN (SELECT has_cycles FROM have) THEN
    jsonb_build_object(
      'refilled_last_35d',        (SELECT count(*) FROM j WHERE last_refill_on >= CURRENT_DATE-35),
      'refilled_last_7d',         (SELECT count(*) FROM j WHERE last_refill_on >= CURRENT_DATE-7),
      'never_refilled',           (SELECT count(*) FROM j WHERE NOT no_cycle_row AND last_refill_on IS NULL),
      'by_tier_last_35d', COALESCE((SELECT jsonb_object_agg(COALESCE(last_tier,'(null)'), n)
        FROM (SELECT last_tier, count(*) n FROM j WHERE last_refill_on >= CURRENT_DATE-35 GROUP BY 1) a), '{}'::jsonb),
      'tier_drift_claimed_vs_current',
        (SELECT count(*) FROM j WHERE last_tier IS NOT NULL AND last_tier <> effective_tier))
    ELSE '"unavailable"'::jsonb END,
  -- public.credit_refills (migration 053) is exactly:
  --   id, user_id, cycle_on date, tier text, included_credits integer, created_at
  --   CONSTRAINT credit_refills_once UNIQUE (user_id, cycle_on)
  -- credits_granted below reports included_credits — the amount the refill actually granted.
  'amount_actually_granted', CASE WHEN (SELECT has_refills FROM have) THEN
    COALESCE((SELECT jsonb_agg(jsonb_build_object('credits_granted', included_credits, 'events', n)
                     ORDER BY included_credits)
      FROM (SELECT r.included_credits, count(*) n FROM public.credit_refills r
             WHERE r.created_at >= now() - interval '35 days'
             GROUP BY r.included_credits) a), '[]'::jsonb)
    ELSE '"unavailable: credit_refills does not exist"'::jsonb END,
  -- The ledger's own tier column, which is more direct than joining through the cycle row.
  'granted_by_tier_last_35d', CASE WHEN (SELECT has_refills FROM have) THEN
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'tier', tier, 'refills', n, 'credits_granted_total', total,
        'distinct_amounts', amounts) ORDER BY tier)
      FROM (SELECT r.tier, count(*) n, sum(r.included_credits) total,
                   count(DISTINCT r.included_credits) amounts
            FROM public.credit_refills r
            WHERE r.created_at >= now() - interval '35 days'
            GROUP BY r.tier) a), '[]'::jsonb)
    ELSE '"unavailable"'::jsonb END,
  -- Grouped on (user_id, cycle_on), which is exactly the credit_refills_once UNIQUE key. A nonzero
  -- value is therefore not a "duplicate refill" in the ordinary sense — it would mean the UNIQUE
  -- constraint is absent from this database. Reported for that reason, not because a duplicate is
  -- expected to be reachable.
  'duplicate_refills_same_cycle', CASE WHEN (SELECT has_refills FROM have) THEN
    jsonb_build_object(
      'duplicate_user_cycle_pairs', (SELECT count(*) FROM (
         SELECT r.user_id, r.cycle_on FROM public.credit_refills r
          GROUP BY r.user_id, r.cycle_on HAVING count(*) > 1) d),
      'unique_constraint_present', EXISTS (
         SELECT 1 FROM pg_catalog.pg_constraint k
         JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'credit_refills'
           AND k.conname = 'credit_refills_once' AND k.contype = 'u'))
    ELSE '"unavailable"'::jsonb END,
  'refill_ledger_totals', CASE WHEN (SELECT has_refills FROM have) THEN
    jsonb_build_object(
      'rows_total',        (SELECT count(*) FROM public.credit_refills),
      'rows_last_35d',     (SELECT count(*) FROM public.credit_refills
                             WHERE created_at >= now() - interval '35 days'),
      'distinct_members',  (SELECT count(DISTINCT user_id) FROM public.credit_refills),
      -- Absolute cycle_on dates are withheld. With a small population, max(cycle_on) is one
      -- member's refill anniversary and therefore a quasi-identifier. The window is reported as
      -- relative day counts instead, which answers "is the ledger current and how far back does
      -- it go" without naming anyone's date.
      'oldest_entry_days_ago', (SELECT (CURRENT_DATE - min(cycle_on)) FROM public.credit_refills),
      'newest_entry_days_ago', (SELECT (CURRENT_DATE - max(cycle_on)) FROM public.credit_refills),
      'ledger_window_days',    (SELECT (max(cycle_on) - min(cycle_on)) FROM public.credit_refills),
      'note', 'Relative day counts only — no absolute cycle_on date is emitted, because in a small '
           || 'population a single calendar date can identify the member it belongs to.')
    ELSE '"unavailable"'::jsonb END,
  'at_capacity_under_proposed_caps', jsonb_build_object(
    'included_already_at_or_over_20',
      (SELECT count(*) FROM public.meeting_credits m WHERE COALESCE(m.free_credits,0) >= 20),
    'combined_at_or_over_50',
      (SELECT count(*) FROM public.meeting_credits m
        WHERE COALESCE(m.free_credits,0) + COALESCE(m.premium_credits,0) >= 50),
    'note', 'Under the proposed model these members would receive a reduced or zero monthly grant. '
         || 'Today the refill REPLACES free_credits with the allowance, so a member at 20 included '
         || 'on the executive tier is refilled to exactly 20 regardless.'),
  'deployed_refill_authority', COALESCE((SELECT jsonb_object_agg(proname, jsonb_build_object(
      'present', true,
      'security_definer', secdef,
      'search_path_config', COALESCE(cfg, '(none)'),
      'replaces_included_rather_than_adding', src LIKE '%free_credits = v_included%',
      'preserves_premium', src LIKE '%premium_credits%',
      'recomputes_balance', src LIKE '%balance%'))
    FROM (SELECT p.proname, p.prosrc AS src, p.prosecdef AS secdef,
                 pg_catalog.array_to_string(p.proconfig, ',') AS cfg
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname IN ('apply_credit_refill','claim_due_credit_refills',
                              'tier_included_credits','effective_credit_tier')) f), '{}'::jsonb),
  'reading_notes', jsonb_build_array(
    'overdue_by_more_than_7 should be 0. A nonzero value means the daily cron is not draining the '
      || 'queue — check REFILL_WORKER_LIMIT (50 members per run) against due_today_or_earlier.',
    'never_refilled counts members whose cycle row exists but has never fired. Migration 053 '
      || 'backfilled existing members to their NEXT FUTURE anniversary, so a recent signup legitimately '
      || 'shows here until their first anniversary.',
    'tier_drift_claimed_vs_current is informational: apply_credit_refill rejects a stale claim and '
      || 'releases the lease, so drift is handled rather than mis-granted.',
    'A tier with db_allowance UNKNOWN is PARKED and granted nothing — that is a real gap, not a zero.',
    'Column names are transcribed from migration 053: credit_refills is (id, user_id, cycle_on, '
      || 'tier, included_credits, created_at). credits_granted reports included_credits.',
    'duplicate_user_cycle_pairs groups on the credit_refills_once UNIQUE key, so a nonzero value '
      || 'means the constraint is missing rather than that a member was refilled twice.',
    'No user id, name, email or per-member timestamp appears in this result.')
)) AS credit_refill_audit;
