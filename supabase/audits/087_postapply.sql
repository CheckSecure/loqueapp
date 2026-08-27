-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 087 POST-APPLY — CREDIT RELEASE 1. READ-ONLY. ONE statement. NO member identities.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Run immediately after migration 087. Proves the final ACL and the new spend order from CATALOG
-- evidence. It performs NO mutating probe and NO role switch.
--
-- WHY THERE IS NO RUNTIME PROBE: demonstrating that `authenticated` cannot UPDATE would mean
-- SET ROLE and attempting a write on a production connection. has_table_privilege is the same
-- authority the executor consults; if it reports false and no column grant exists, the role cannot
-- write any row. Balance drift is expected to be UNCHANGED here — 087 repairs nothing.
WITH
priv AS (
  SELECT r.rolname, p.priv, pg_catalog.has_table_privilege(r.rolname,'public.meeting_credits'::regclass,p.priv) AS held
  FROM (VALUES ('anon'),('authenticated'),('service_role')) r(rolname)
  CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
  WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles x WHERE x.rolname=r.rolname)
),
pub AS (
  SELECT COALESCE(pg_catalog.string_agg(DISTINCT x.privilege_type,',' ORDER BY x.privilege_type),'(none)') AS privs
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) x
  WHERE n.nspname='public' AND c.relname='meeting_credits' AND x.grantee=0
),
cols AS (
  SELECT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_catalog.pg_roles WHERE oid=x.grantee) END AS grantee,
         a.attname AS col, x.privilege_type AS priv
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
  CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
  WHERE n.nspname='public' AND c.relname='meeting_credits' AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
),
pol AS (
  SELECT policyname, permissive, roles::text AS applies_to, cmd,
         COALESCE(qual,'(none)') AS using_expr, COALESCE(with_check,'(none)') AS check_expr
  FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename='meeting_credits'
),
drift AS (
  SELECT count(*) AS rows_total,
    count(*) FILTER (WHERE COALESCE(balance,0) <> COALESCE(free_credits,0)+COALESCE(premium_credits,0)) AS drifted,
    COALESCE(max(abs(COALESCE(balance,0)-(COALESCE(free_credits,0)+COALESCE(premium_credits,0)))),0) AS max_drift,
    count(*) FILTER (WHERE COALESCE(free_credits,0)<0) AS neg_free,
    count(*) FILTER (WHERE COALESCE(premium_credits,0)<0) AS neg_premium,
    count(*) FILTER (WHERE COALESCE(balance,0)<0) AS neg_balance,
    count(*) FILTER (WHERE COALESCE(premium_credits,0)>0 AND COALESCE(free_credits,0)=0) AS premium_only_members
  FROM public.meeting_credits
),
spend AS (
  SELECT p.prosrc AS src, p.prosecdef AS secdef, pg_catalog.array_to_string(p.proconfig,',') AS cfg
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='consume_credits_and_create_match' LIMIT 1
)
SELECT jsonb_pretty(jsonb_build_object(
  'generated_at', now(),

  'ledger_by_source_and_bucket', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'source_kind', COALESCE(source_kind,'(unset)'), 'funded_from', COALESCE(funded_from,'(null)'),
      'amount', amount, 'events', n) ORDER BY 1,2)
    FROM (SELECT source_kind, funded_from, amount, count(*) n FROM public.credit_transactions
          GROUP BY 1,2,3) a), '[]'::jsonb),
  'meeting_credits_acl', jsonb_build_object(
    'owner', (SELECT r.rolname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
              JOIN pg_catalog.pg_roles r ON r.oid=c.relowner WHERE n.nspname='public' AND c.relname='meeting_credits'),
    'rls_enabled', (SELECT c.relrowsecurity FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname='public' AND c.relname='meeting_credits'),
    'rls_forced', (SELECT c.relforcerowsecurity FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                   WHERE n.nspname='public' AND c.relname='meeting_credits'),
    'PUBLIC', (SELECT privs FROM pub),
    'effective_table_privileges', COALESCE((SELECT jsonb_object_agg(rolname, privs) FROM (
       SELECT rolname, COALESCE(pg_catalog.string_agg(priv,',' ORDER BY priv) FILTER (WHERE held),'(none)') AS privs
       FROM priv GROUP BY rolname) a), '{}'::jsonb),
    'explicit_column_grants', COALESCE((SELECT jsonb_agg(jsonb_build_object('grantee',grantee,'column',col,'privilege',priv) ORDER BY grantee,col) FROM cols), '[]'::jsonb),
    'policy_count', (SELECT count(*) FROM pol),
    'policies', COALESCE((SELECT jsonb_agg(jsonb_build_object('policy',policyname,'permissive',permissive,
       'applies_to',applies_to,'command',cmd,'using',using_expr,'with_check',check_expr) ORDER BY policyname) FROM pol), '[]'::jsonb)),
  'spend_authority', (SELECT jsonb_build_object(
      'present', src IS NOT NULL,
      'security_definer', secdef, 'search_path_config', COALESCE(cfg,'(none)'),
      'references_premium_credits', src LIKE '%premium_credits%',
      'free_only_predicate_present', src LIKE '%AND free_credits >= 1%',
      'locks_rows_for_update', src LIKE '%FOR UPDATE%',
      'reads_is_admin_for_share', src LIKE '%FOR SHARE%',
      'writes_ledger', src LIKE '%credit_transactions%',
      'records_funded_from', src LIKE '%funded_from%') FROM spend),
  'balance_state', (SELECT to_jsonb(d) FROM drift d),
  'invariant_constraints', jsonb_build_object(
    'balance_invariant_present', EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname='meeting_credits_balance_invariant'),
    'buckets_non_negative_present', EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname='meeting_credits_buckets_non_negative')),
  'ledger_by_source_and_bucket', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'source_kind', COALESCE(source_kind,'(unset)'), 'funded_from', COALESCE(funded_from,'(null)'),
      'amount', amount, 'events', n) ORDER BY 1,2)
    FROM (SELECT source_kind, funded_from, amount, count(*) n FROM public.credit_transactions
          GROUP BY 1,2,3) a), '[]'::jsonb),
  'checks', jsonb_build_object(
    'browser_zero_writes', NOT EXISTS (SELECT 1 FROM priv WHERE rolname IN ('anon','authenticated')
        AND priv IN ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER') AND held),
    'anon_zero_privileges', NOT EXISTS (SELECT 1 FROM priv WHERE rolname='anon' AND held),
    'authenticated_select_only', (SELECT bool_and(CASE WHEN priv='SELECT' THEN held ELSE NOT held END)
        FROM priv WHERE rolname='authenticated'),
    'public_zero', (SELECT privs = '(none)' FROM pub),
    'zero_explicit_column_grants', NOT EXISTS (SELECT 1 FROM cols),
    'rls_enabled', (SELECT c.relrowsecurity FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname='meeting_credits'),
    'exactly_one_select_only_policy', (SELECT count(*)=1 FROM pol WHERE cmd='SELECT')
        AND (SELECT count(*)=1 FROM pol),
    'service_role_select_insert_update_only',
      (SELECT bool_and(CASE WHEN priv IN ('SELECT','INSERT','UPDATE') THEN held ELSE NOT held END)
       FROM priv WHERE rolname='service_role'),
    'spend_reaches_premium', (SELECT src LIKE '%premium_credits%' FROM spend),
    'free_only_predicate_gone', (SELECT src NOT LIKE '%AND free_credits >= 1%' FROM spend),
    'deterministic_row_lock', (SELECT src LIKE '%FOR UPDATE%' FROM spend),
    'admin_exemption_intact', (SELECT src LIKE '%is_admin%' AND src LIKE '%FOR SHARE%' FROM spend),
    'ledger_intact', (SELECT src LIKE '%event_key%' AND src LIKE '%credit_transactions%' FROM spend)),
  'operator_must_compare', jsonb_build_array(
    'balance_state MUST be identical to the preflight — 087 repairs no row. A change here means '
      || 'something else wrote to meeting_credits during the migration window.',
    'invariant_constraints should both be FALSE at this point; they arrive with migration 088.'),
  'verdict', CASE
    WHEN EXISTS (SELECT 1 FROM priv WHERE rolname IN ('anon','authenticated')
                  AND priv <> 'SELECT' AND held) THEN 'FAIL: a browser role still holds a write privilege'
    WHEN EXISTS (SELECT 1 FROM priv WHERE rolname='anon' AND held) THEN 'FAIL: anon holds a privilege'
    WHEN NOT (SELECT bool_or(held) FROM priv WHERE rolname='authenticated' AND priv='SELECT')
      THEN 'FAIL: authenticated lost SELECT — the billing self-read is broken'
    WHEN (SELECT privs FROM pub) <> '(none)' THEN 'FAIL: a PUBLIC ACL entry remains'
    WHEN EXISTS (SELECT 1 FROM cols) THEN 'FAIL: an explicit column grant remains'
    WHEN NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c
              JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='public' AND c.relname='meeting_credits') THEN 'FAIL: RLS is off'
    WHEN (SELECT count(*) FROM pol) <> 1 THEN 'FAIL: expected exactly one policy'
    WHEN (SELECT src LIKE '%AND free_credits >= 1%' FROM spend) THEN 'FAIL: the free-only predicate survived'
    WHEN NOT (SELECT src LIKE '%premium_credits%' FROM spend) THEN 'FAIL: the spend function ignores premium_credits'
    ELSE 'PASS — purchased credits are spendable and meeting_credits is browser-read-only' END
)) AS postapply_087;
