-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- CREDIT STATE CENSUS — READ-ONLY. ONE statement. AGGREGATE ONLY. NO identities.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Measures the current credit model against the proposed caps (included ≤ 20, combined ≤ 50) and
-- against its own invariant (balance = free_credits + premium_credits). It CHANGES NOTHING.
--
-- NO IDENTITIES. Counts, buckets and booleans only — no user id, name, email, Stripe id, session
-- id, price id, amount, or timestamp of any member appears anywhere in the result.
--
-- ─── DEPLOYED STATE IS DETECTED, NEVER ASSUMED ────────────────────────────────────────────────
-- A migration file's header comment is not evidence of what is deployed. Migration 072's header
-- still reads "NOT YET APPLIED" even though 072 and 073 were applied and verified in production.
-- This audit therefore reads the DATABASE: the presence of 072's columns, unique index, append-only
-- trigger, and the actual body of public.consume_credits_and_create_match. Every claim about the
-- deployed match authority below is derived from pg_proc.prosrc and pg_catalog, not from a file.
--
-- ─── WHAT THE SCHEMA CAN AND CANNOT PROVE ─────────────────────────────────────────────────────
-- Where a question cannot be answered from the schema, the field says so rather than guessing.
--
-- Optional columns and tables are probed through to_jsonb / to_regclass so a schema that lacks
-- them yields NULL rather than raising.
WITH prof AS (
  SELECT p.id, p.is_admin, p.is_test_account, p.account_status,
         COALESCE(NULLIF(btrim(COALESCE(p.subscription_tier, '')), ''), 'free') AS tier,
         p.is_founding_member, p.founding_member_expires_at
  FROM public.profiles p
),
real_members AS (SELECT * FROM prof WHERE is_test_account IS NOT TRUE),
mc AS (
  SELECT m.user_id,
         COALESCE(m.free_credits, 0)    AS free_credits,
         COALESCE(m.premium_credits, 0) AS premium_credits,
         COALESCE(m.balance, 0)         AS balance,
         COALESCE(m.lifetime_earned, 0) AS lifetime_earned,
         (m.free_credits IS NULL OR m.premium_credits IS NULL OR m.balance IS NULL) AS has_null_bucket
  FROM public.meeting_credits m
),
joined AS (
  SELECT r.id, r.tier, r.is_admin, r.account_status,
         c.free_credits, c.premium_credits, c.balance, c.lifetime_earned, c.has_null_bucket,
         (c.user_id IS NULL) AS no_credit_row,
         COALESCE(c.free_credits, 0) + COALESCE(c.premium_credits, 0) AS combined
  FROM real_members r LEFT JOIN mc c ON c.user_id = r.id
),
bucketed AS (
  SELECT j.*,
    CASE WHEN no_credit_row THEN '(no row)'
         WHEN combined = 0 THEN '0'
         WHEN combined BETWEEN 1 AND 3   THEN '1-3'
         WHEN combined BETWEEN 4 AND 10  THEN '4-10'
         WHEN combined BETWEEN 11 AND 20 THEN '11-20'
         WHEN combined BETWEEN 21 AND 50 THEN '21-50'
         ELSE '51+' END AS combined_bucket,
    CASE WHEN no_credit_row THEN '(no row)'
         WHEN free_credits = 0 THEN '0'
         WHEN free_credits BETWEEN 1 AND 3   THEN '1-3'
         WHEN free_credits BETWEEN 4 AND 10  THEN '4-10'
         WHEN free_credits BETWEEN 11 AND 20 THEN '11-20'
         ELSE '21+' END AS free_bucket,
    CASE WHEN no_credit_row THEN '(no row)'
         WHEN premium_credits = 0 THEN '0'
         WHEN premium_credits BETWEEN 1 AND 5   THEN '1-5'
         WHEN premium_credits BETWEEN 6 AND 20  THEN '6-20'
         WHEN premium_credits BETWEEN 21 AND 50 THEN '21-50'
         ELSE '51+' END AS premium_bucket
  FROM joined j
),
-- Ledger tables are optional: to_regclass yields NULL when absent, and every dependent count is
-- then reported as unavailable rather than zero.
have AS (
  SELECT to_regclass('public.credit_transactions')     IS NOT NULL AS has_tx,
         to_regclass('public.credit_grants')           IS NOT NULL AS has_grants,
         to_regclass('public.credit_refills')          IS NOT NULL AS has_refills,
         to_regclass('public.membership_credit_cycles') IS NOT NULL AS has_cycles
),
tx_recent AS (
  SELECT COALESCE(NULLIF(btrim(COALESCE(t.source_kind, '')), ''), '(unset)') AS source_kind,
         CASE WHEN t.amount > 0 THEN 'credit' WHEN t.amount < 0 THEN 'debit' ELSE 'zero' END AS direction,
         count(*) AS n
  FROM public.credit_transactions t
  WHERE (SELECT has_tx FROM have) AND t.created_at >= now() - interval '90 days'
  GROUP BY 1, 2
),
tx_dupe AS (
  SELECT count(*) AS duplicate_event_keys FROM (
    SELECT t.event_key FROM public.credit_transactions t
    WHERE (SELECT has_tx FROM have) AND t.event_key IS NOT NULL
    GROUP BY t.event_key HAVING count(*) > 1) d
),
refills_recent AS (
  SELECT c.last_tier AS tier, count(*) AS n
  FROM public.membership_credit_cycles c
  WHERE (SELECT has_cycles FROM have) AND c.last_refill_on >= (CURRENT_DATE - 35)
  GROUP BY 1
)
SELECT jsonb_pretty(jsonb_build_object(
  'generated_at', now(),
  'population', jsonb_build_object(
    'profiles_total',        (SELECT count(*) FROM prof),
    'real_members',          (SELECT count(*) FROM real_members),
    'admins',                (SELECT count(*) FROM real_members WHERE is_admin IS TRUE),
    'accounts_without_credit_row', (SELECT count(*) FROM bucketed WHERE no_credit_row),
    'rows_with_a_null_bucket',     (SELECT count(*) FROM bucketed WHERE has_null_bucket)),
  'by_tier', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'tier', tier, 'members', n, 'with_credit_row', with_row,
      'median_combined', med, 'max_combined', mx) ORDER BY tier)
    FROM (SELECT tier, count(*) AS n, count(*) FILTER (WHERE NOT no_credit_row) AS with_row,
                 COALESCE(percentile_disc(0.5) WITHIN GROUP (ORDER BY combined), 0) AS med,
                 COALESCE(max(combined), 0) AS mx
          FROM bucketed GROUP BY tier) x), '[]'::jsonb),
  'distribution', jsonb_build_object(
    'combined', COALESCE((SELECT jsonb_object_agg(combined_bucket, n)
       FROM (SELECT combined_bucket, count(*) n FROM bucketed GROUP BY 1) a), '{}'::jsonb),
    'free_included', COALESCE((SELECT jsonb_object_agg(free_bucket, n)
       FROM (SELECT free_bucket, count(*) n FROM bucketed GROUP BY 1) a), '{}'::jsonb),
    'premium_purchased', COALESCE((SELECT jsonb_object_agg(premium_bucket, n)
       FROM (SELECT premium_bucket, count(*) n FROM bucketed GROUP BY 1) a), '{}'::jsonb)),
  'against_proposed_caps', jsonb_build_object(
    'included_over_20',            (SELECT count(*) FROM bucketed WHERE NOT no_credit_row AND free_credits > 20),
    'combined_over_50',            (SELECT count(*) FROM bucketed WHERE NOT no_credit_row AND combined > 50),
    'combined_over_50_max_excess', (SELECT COALESCE(max(combined) - 50, 0) FROM bucketed WHERE combined > 50),
    'note', 'These are the accounts a cap would grandfather. Product direction is that they spend '
         || 'down and are never reduced automatically.'),
  'integrity', jsonb_build_object(
    'negative_free',    (SELECT count(*) FROM bucketed WHERE free_credits < 0),
    'negative_premium', (SELECT count(*) FROM bucketed WHERE premium_credits < 0),
    'negative_balance', (SELECT count(*) FROM bucketed WHERE balance < 0),
    'invariant_violations_balance_ne_free_plus_premium',
      (SELECT count(*) FROM bucketed WHERE NOT no_credit_row AND balance <> combined),
    'max_invariant_drift',
      (SELECT COALESCE(max(abs(balance - combined)), 0) FROM bucketed WHERE NOT no_credit_row)),
  'unspendable_purchased_credits', jsonb_build_object(
    'premium_positive_and_free_zero',
      (SELECT count(*) FROM bucketed WHERE NOT no_credit_row AND premium_credits > 0 AND free_credits = 0),
    'total_premium_credits_held',
      (SELECT COALESCE(sum(premium_credits), 0) FROM bucketed WHERE NOT no_credit_row),
    'premium_credits_stranded_at_free_zero',
      (SELECT COALESCE(sum(premium_credits), 0) FROM bucketed
        WHERE NOT no_credit_row AND free_credits = 0),
    'note', 'The deployed match path charges free_credits ONLY (WHERE free_credits >= 1). Members '
         || 'in premium_positive_and_free_zero cannot spend the credits they paid for.'),
  'ledger', jsonb_build_object(
    'tables_present', (SELECT to_jsonb(h) FROM have h),
    'transactions_last_90d_by_source', CASE WHEN (SELECT has_tx FROM have)
      THEN COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'source_kind', source_kind, 'direction', direction, 'events', n)
             ORDER BY source_kind, direction) FROM tx_recent), '[]'::jsonb)
      ELSE '"unavailable: credit_transactions does not exist"'::jsonb END,
    'duplicate_event_keys', CASE WHEN (SELECT has_tx FROM have)
      THEN to_jsonb((SELECT duplicate_event_keys FROM tx_dupe))
      ELSE '"unavailable"'::jsonb END,
    'refills_last_35d_by_tier', CASE WHEN (SELECT has_cycles FROM have)
      THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('tier', tier, 'refills', n) ORDER BY tier)
                       FROM refills_recent), '[]'::jsonb)
      ELSE '"unavailable"'::jsonb END,
    'grants_total', CASE WHEN (SELECT has_grants FROM have)
      THEN to_jsonb((SELECT count(*) FROM public.credit_grants)) ELSE '"unavailable"'::jsonb END),
  -- ── DEPLOYED MATCH AUTHORITY, READ FROM pg_proc ────────────────────────────────────────────
  'deployed_match_authority', (SELECT jsonb_build_object(
      'function_present', f.src IS NOT NULL,
      'debits_free_credits_only',
        f.src IS NOT NULL AND f.src LIKE '%free_credits >= 1%'
                          AND f.src NOT LIKE '%premium_credits >= 1%'
                          AND f.src NOT LIKE '%premium_credits - 1%',
      'premium_only_member_can_complete_a_match',
        CASE WHEN f.src IS NULL THEN NULL
             ELSE NOT (f.src LIKE '%free_credits >= 1%') END,
      'writes_a_debit_ledger_event',
        f.src IS NOT NULL AND f.src LIKE '%credit_transactions%',
      'exempts_administrators',
        f.src IS NOT NULL AND f.src LIKE '%is_admin%',
      'reads_is_admin_under_row_lock',
        f.src IS NOT NULL AND f.src LIKE '%FOR SHARE%',
      'uses_event_key_idempotency',
        f.src IS NOT NULL AND f.src LIKE '%event_key%',
      'security_definer', f.secdef,
      'search_path_config', COALESCE(f.cfg, '(none)'),
      'note', 'Derived from pg_proc.prosrc of public.consume_credits_and_create_match. '
           || 'debits_free_credits_only TRUE with premium_only_member_can_complete_a_match FALSE '
           || 'is the confirmed defect: purchased credits cannot be spent on a match.')
    FROM (SELECT p.prosrc AS src, p.prosecdef AS secdef,
                 pg_catalog.array_to_string(p.proconfig, ',') AS cfg
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'consume_credits_and_create_match'
          LIMIT 1) f),
  -- ── ARE 072 AND 073 ACTUALLY DEPLOYED? (objects, not headers) ──────────────────────────────
  'migration_072_073_deployed_markers', jsonb_build_object(
    'credit_transactions_has_event_key',   EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='credit_transactions' AND column_name='event_key'),
    'credit_transactions_has_source_kind', EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='credit_transactions' AND column_name='source_kind'),
    'credit_transactions_has_source_id',   EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='credit_transactions' AND column_name='source_id'),
    'event_key_unique_index_present', EXISTS (SELECT 1 FROM pg_catalog.pg_indexes
      WHERE schemaname='public' AND indexname='credit_transactions_event_key_uniq'),
    'append_only_trigger_present', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g
      JOIN pg_catalog.pg_class c ON c.oid=g.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='credit_transactions'
        AND g.tgname='credit_transactions_append_only' AND NOT g.tgisinternal),
    'credit_transactions_acl', COALESCE((SELECT jsonb_object_agg(role, privs) FROM (
      SELECT r.rolname AS role, COALESCE(pg_catalog.string_agg(p.priv, ',' ORDER BY p.priv)
               FILTER (WHERE pg_catalog.has_table_privilege(r.rolname,
                 'public.credit_transactions'::regclass, p.priv)), '(none)') AS privs
      FROM (VALUES ('anon'),('authenticated'),('service_role')) AS r(rolname)
      CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
                         ('TRUNCATE'),('REFERENCES'),('TRIGGER')) AS p(priv)
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles pr WHERE pr.rolname = r.rolname)
      GROUP BY r.rolname) a), '{}'::jsonb),
    'note', '072 replaced consume_credits_and_create_match and added the ledger columns, unique '
         || 'index and append-only trigger; 073 set the final credit_transactions ACL. All markers '
         || 'true means both are deployed, regardless of what any migration header says.'),
  -- ── CAN A MEMBER CHANGE THEIR OWN BALANCE? ─────────────────────────────────────────────────
  'meeting_credits_privileges', jsonb_build_object(
    'table_present', to_regclass('public.meeting_credits') IS NOT NULL,
    'owner', (SELECT r.rolname FROM pg_catalog.pg_class c
              JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
              JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
              WHERE n.nspname='public' AND c.relname='meeting_credits'),
    'rls_enabled', (SELECT c.relrowsecurity FROM pg_catalog.pg_class c
                    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname='public' AND c.relname='meeting_credits'),
    'rls_forced',  (SELECT c.relforcerowsecurity FROM pg_catalog.pg_class c
                    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname='public' AND c.relname='meeting_credits'),
    'policy_count', (SELECT count(*) FROM pg_catalog.pg_policies
                     WHERE schemaname='public' AND tablename='meeting_credits'),
    'policies', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'policy', policyname, 'permissive', permissive, 'applies_to', roles::text, 'command', cmd,
        'using', COALESCE(qual,'(none)'), 'with_check', COALESCE(with_check,'(none)'))
        ORDER BY policyname)
      FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename='meeting_credits'), '[]'::jsonb),
    -- Effective TABLE privileges, all seven, for every browser role plus service_role.
    'effective_table_privileges', COALESCE((SELECT jsonb_object_agg(role, privs) FROM (
      SELECT r.rolname AS role, COALESCE(pg_catalog.string_agg(p.priv, ',' ORDER BY p.priv)
               FILTER (WHERE pg_catalog.has_table_privilege(r.rolname,
                 'public.meeting_credits'::regclass, p.priv)), '(none)') AS privs
      FROM (VALUES ('anon'),('authenticated'),('service_role')) AS r(rolname)
      CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
                         ('TRUNCATE'),('REFERENCES'),('TRIGGER')) AS p(priv)
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles pr WHERE pr.rolname = r.rolname)
      GROUP BY r.rolname) a), '{}'::jsonb),
    -- PUBLIC is the pseudo-role: has_table_privilege cannot be asked about it, so read the ACL.
    'public_pseudo_role_acl', COALESCE((SELECT pg_catalog.string_agg(DISTINCT x.privilege_type, ','
        ORDER BY x.privilege_type)
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) x
      WHERE n.nspname='public' AND c.relname='meeting_credits' AND x.grantee = 0), '(none)'),
    -- EXPLICIT column grants only (pg_attribute.attacl); a table grant is NOT a column grant.
    'explicit_column_grants', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'grantee', CASE WHEN x.grantee=0 THEN 'PUBLIC'
                        ELSE (SELECT rolname FROM pg_catalog.pg_roles WHERE oid=x.grantee) END,
        'column', a.attname, 'privilege', x.privilege_type) ORDER BY a.attname)
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
      CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
      WHERE n.nspname='public' AND c.relname='meeting_credits'
        AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL), '[]'::jsonb)),
  -- THE QUESTION THAT MATTERS: can a logged-in member rewrite their own balance?
  'authenticated_can_modify_own_credits', (SELECT jsonb_build_object(
      'update', pg_catalog.has_table_privilege('authenticated','public.meeting_credits'::regclass,'UPDATE'),
      'insert', pg_catalog.has_table_privilege('authenticated','public.meeting_credits'::regclass,'INSERT'),
      'delete', pg_catalog.has_table_privilege('authenticated','public.meeting_credits'::regclass,'DELETE'),
      'select', pg_catalog.has_table_privilege('authenticated','public.meeting_credits'::regclass,'SELECT'),
      'rls_would_restrict_rows', (SELECT c.relrowsecurity FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname='meeting_credits'),
      'columns_at_risk', jsonb_build_array('free_credits','premium_credits','balance','lifetime_earned'),
      'verdict', CASE
        WHEN pg_catalog.has_table_privilege('authenticated','public.meeting_credits'::regclass,'UPDATE')
         AND NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c
                  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname='meeting_credits')
        THEN 'CRITICAL: authenticated holds UPDATE and RLS is OFF — a member can set free_credits, '
             || 'premium_credits, balance and lifetime_earned to any value from the browser.'
        WHEN pg_catalog.has_table_privilege('authenticated','public.meeting_credits'::regclass,'UPDATE')
        THEN 'REVIEW: authenticated holds UPDATE; RLS is on — read the policies above to see which '
             || 'rows and columns are actually writable.'
        ELSE 'OK: authenticated cannot UPDATE public.meeting_credits.' END)
    WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='authenticated')),
  'matches_without_debit_authority', (SELECT CASE
      WHEN f.src IS NOT NULL AND f.src LIKE '%credit_transactions%'
      THEN jsonb_build_object('determinable', true,
             'matches_created_last_90d', (SELECT count(*) FROM public.matches
                WHERE created_at >= now() - interval '90 days'),
             'match_debit_events_last_90d', (SELECT count(*) FROM public.credit_transactions
                WHERE created_at >= now() - interval '90 days'
                  -- 'match_debit' is the literal migration 072 writes. An earlier version of this
                  -- audit guessed at 'match'/'mutual_match'/'finalize_mutual_match' and therefore
                  -- reported 0 while the by-source section correctly showed the events.
                  AND COALESCE(source_kind,'') = 'match_debit'),
             'match_exempt_events_last_90d', (SELECT count(*) FROM public.credit_transactions
                WHERE created_at >= now() - interval '90 days'
                  AND COALESCE(source_kind,'') = 'match_exempt_admin'),
             'note', 'The deployed match authority writes a debit event, so the two counts are '
                  || 'comparable. They will NOT be equal: admin-exempt pairs are charged nothing '
                  || 'by design, and each chargeable match writes one event per charged member. '
                  || 'Treat a debit count far BELOW the match count as the signal, not equality.')
      ELSE jsonb_build_object('determinable', false,
             'why', 'The deployed consume_credits_and_create_match does not reference '
                 || 'credit_transactions, so no per-match debit record exists to join against.')
    END FROM (SELECT p.prosrc AS src FROM pg_catalog.pg_proc p
              JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='consume_credits_and_create_match' LIMIT 1) f),
  'reading_notes', jsonb_build_array(
    'invariant_violations_balance_ne_free_plus_premium should be 0: every writer recomputes '
      || 'balance = free + premium. A nonzero value means a writer exists that does not.',
    'premium_positive_and_free_zero is the size of the paid-but-unspendable population.',
    'deployed_match_authority and migration_072_073_deployed_markers are read from pg_proc and '
      || 'pg_catalog — never from a migration file header, which can be and is stale.',
    'authenticated_can_modify_own_credits.verdict is the highest-severity field here. A CRITICAL '
      || 'result means the credit balance is member-writable and no application-level cap is '
      || 'enforceable until it is fixed.',
    'No user id, name, email, Stripe identifier, amount or timestamp appears in this result.')
)) AS credit_state_census;
