-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- POST-REPAIR — balance reconciliation. READ-ONLY. ONE statement. NO member identities.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Run after supabase/repairs/meeting_credits_balance_reconciliation.PROPOSED.sql, and BEFORE
-- migration 088. 088 refuses while any violation remains, so this audit is the gate that says
-- whether 088 may proceed.
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
  'balance_state', (SELECT to_jsonb(d) FROM drift d),
  'invariant_constraints', jsonb_build_object(
    'balance_invariant_present', EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname='meeting_credits_balance_invariant'),
    'buckets_non_negative_present', EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname='meeting_credits_buckets_non_negative')),
  'meeting_credits_acl_full', jsonb_build_object(
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
  'acl_unchanged_by_the_repair', jsonb_build_object(
    'rls_enabled', (SELECT c.relrowsecurity FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname='meeting_credits'),
    'policy_count', (SELECT count(*) FROM pol),
    'effective_table_privileges', COALESCE((SELECT jsonb_object_agg(rolname, privs) FROM (
       SELECT rolname, COALESCE(pg_catalog.string_agg(priv,',' ORDER BY priv) FILTER (WHERE held),'(none)') AS privs
       FROM priv GROUP BY rolname) a), '{}'::jsonb)),
  'operator_must_compare', jsonb_build_array(
    'rows_total MUST equal the value the post-apply audit reported. The repair updates rows; it '
      || 'never creates or removes one.',
    'premium_only_members should be UNCHANGED — the repair rewrites balance only, never a bucket.'),
  'verdict', (SELECT CASE
      WHEN d.drifted <> 0 THEN 'BLOCKER: ' || d.drifted || ' row(s) still violate the invariant — DO NOT apply 088'
      WHEN d.neg_free <> 0 OR d.neg_premium <> 0 OR d.neg_balance <> 0
        THEN 'BLOCKER: a negative bucket or balance exists — 088 would fail'
      ELSE 'PASS — zero drift, no negatives. Migration 088 may be applied.' END FROM drift d)
)) AS postrepair_reconciliation;
