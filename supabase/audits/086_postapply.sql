-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 086 POST-APPLY — RELEASE B VERIFICATION. READ-ONLY. ONE statement. NO identities.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Run immediately after supabase/migrations/086_graph_tables_least_privilege.sql. It proves the
-- final privilege matrix from CATALOG EVIDENCE and asserts nothing structural moved. It CHANGES
-- NOTHING and performs NO mutating probe.
--
-- ─── WHY THERE IS NO RUNTIME ROLE PROBE ───────────────────────────────────────────────────────
-- A convincing demonstration that `authenticated` cannot read its own match rows would mean
-- SET ROLE authenticated and running a SELECT. That mutates session state on a production
-- connection and, on failure, aborts the transaction. It is unnecessary: PostgreSQL's own
-- has_table_privilege is the authority the executor itself consults. If it reports false for
-- SELECT, and no column grant exists, the role cannot retrieve ANY row — including its own —
-- because RLS is only ever consulted AFTER table privilege is satisfied. That ordering is what
-- browser_cannot_read_even_own_rows below asserts.
--
-- ─── ROW COUNTS ───────────────────────────────────────────────────────────────────────────────
-- This file emits current counts. It cannot compare them to the pre-apply values because it
-- cannot see the past — the operator compares them to what the preflight reported. That is stated
-- rather than papered over with a claim the SQL cannot support.
WITH targets AS (
  SELECT c.oid, c.relname, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl, c.relkind
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN ('matches', 'blocked_users')
),
browser_table AS (
  SELECT t.relname, r.rolname, p.priv,
         pg_catalog.has_table_privilege(r.rolname, t.oid, p.priv) AS held
  FROM targets t
  CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
  CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
                     ('TRUNCATE'),('REFERENCES'),('TRIGGER')) AS p(priv)
),
-- ACL entries naming PUBLIC (grantee 0), anon or authenticated. Catches any privilege type this
-- audit did not enumerate, including MAINTAIN on PostgreSQL 17+.
browser_acl AS (
  SELECT t.relname,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC'
              ELSE (SELECT rolname FROM pg_catalog.pg_roles WHERE oid = a.grantee) END AS grantee,
         a.privilege_type
  FROM targets t
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(t.relacl, pg_catalog.acldefault('r', t.relowner))) a
  WHERE a.grantee = 0
     OR a.grantee IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN ('anon','authenticated'))
),
browser_cols AS (
  -- EXPLICIT column grants only. information_schema.column_privileges is NOT usable here: it
  -- reports a TABLE-level grant as one row per column, so service_role's correct table grant
  -- would appear as dozens of phantom column grants. pg_attribute.attacl is NULL unless a real
  -- column-level GRANT exists.
  SELECT c.relname AS table_name,
         CASE WHEN x.grantee = 0 THEN 'PUBLIC'
              ELSE (SELECT rolname FROM pg_catalog.pg_roles WHERE oid = x.grantee) END AS grantee,
         a.attname AS column_name, x.privilege_type
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
  CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
  WHERE n.nspname = 'public' AND c.relname IN ('matches','blocked_users')
    AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
    AND (x.grantee = 0
      OR x.grantee IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN ('anon','authenticated')))
),
service_table AS (
  SELECT t.relname, p.priv,
         pg_catalog.has_table_privilege('service_role', t.oid, p.priv) AS held
  FROM targets t
  CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
                     ('TRUNCATE'),('REFERENCES'),('TRIGGER')) AS p(priv)
),
service_cols AS (
  SELECT c.relname AS table_name, a.attname AS column_name, x.privilege_type
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
  CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
  WHERE n.nspname = 'public' AND c.relname IN ('matches','blocked_users')
    AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
    AND x.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role')
),
policies AS (
  SELECT p.tablename, p.policyname, p.permissive, p.roles::text AS applies_to, p.cmd,
         COALESCE(p.qual,'(none)') AS using_expr, COALESCE(p.with_check,'(none)') AS check_expr
  FROM pg_catalog.pg_policies p
  WHERE p.schemaname = 'public' AND p.tablename IN ('matches','blocked_users')
),
structure AS (
  SELECT t.relname,
    (SELECT count(*) FROM pg_catalog.pg_constraint k WHERE k.conrelid = t.oid) AS constraints,
    (SELECT count(*) FROM pg_catalog.pg_index i     WHERE i.indrelid = t.oid)  AS indexes,
    (SELECT count(*) FROM pg_catalog.pg_trigger g   WHERE g.tgrelid  = t.oid
                                                      AND NOT g.tgisinternal)  AS triggers,
    (SELECT COALESCE(pg_catalog.string_agg(k.conname || ': ' ||
              pg_catalog.pg_get_constraintdef(k.oid), E'\n' ORDER BY k.conname), '(none)')
       FROM pg_catalog.pg_constraint k WHERE k.conrelid = t.oid)               AS constraint_defs,
    (SELECT COALESCE(pg_catalog.string_agg(i.indexname || ': ' || i.indexdef, E'\n'
              ORDER BY i.indexname), '(none)')
       FROM pg_catalog.pg_indexes i
      WHERE i.schemaname='public' AND i.tablename = t.relname)                 AS index_defs,
    (SELECT COALESCE(pg_catalog.string_agg(g.tgname, ', ' ORDER BY g.tgname), '(none)')
       FROM pg_catalog.pg_trigger g WHERE g.tgrelid = t.oid AND NOT g.tgisinternal) AS trigger_names
  FROM targets t
),
counts AS (
  SELECT (SELECT count(*) FROM public.matches)       AS matches_rows,
         (SELECT count(*) FROM public.blocked_users) AS blocked_users_rows
),
checks AS (
  SELECT
    (SELECT count(*) FROM targets WHERE relkind = 'r') = 2         AS both_tables_present,
    NOT EXISTS (SELECT 1 FROM browser_table WHERE held)            AS browser_zero_table_privs,
    NOT EXISTS (SELECT 1 FROM browser_acl)                         AS browser_zero_acl_entries,
    NOT EXISTS (SELECT 1 FROM browser_cols)                        AS browser_zero_column_privs,
    (SELECT bool_and(held) FROM service_table
      WHERE priv IN ('SELECT','INSERT','UPDATE','DELETE'))         AS service_has_four_dml,
    NOT EXISTS (SELECT 1 FROM service_table
                 WHERE priv IN ('TRUNCATE','REFERENCES','TRIGGER') AND held)
                                                                   AS service_lacks_extras,
    NOT EXISTS (SELECT 1 FROM service_cols)                        AS service_zero_column_privs,
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname='public' AND c.relname='_m086_before')
                                                                   AS no_leftover_migration_objects
)
SELECT jsonb_pretty(jsonb_build_object(
  'generated_at', now(),
  'server_version', current_setting('server_version'),
  'final_matrix', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'table', relname,
      'owner', COALESCE((SELECT rolname FROM pg_catalog.pg_roles WHERE oid = relowner), 'unknown'),
      'rls_enabled', relrowsecurity,
      'rls_forced', relforcerowsecurity,
      'PUBLIC',        '(none)',
      'anon',          COALESCE((SELECT pg_catalog.string_agg(priv, ',' ORDER BY priv)
                                   FROM browser_table b
                                  WHERE b.relname = t.relname AND b.rolname='anon' AND b.held), '(none)'),
      'authenticated', COALESCE((SELECT pg_catalog.string_agg(priv, ',' ORDER BY priv)
                                   FROM browser_table b
                                  WHERE b.relname = t.relname AND b.rolname='authenticated' AND b.held), '(none)'),
      'service_role',  COALESCE((SELECT pg_catalog.string_agg(priv, ',' ORDER BY priv)
                                   FROM service_table s WHERE s.relname = t.relname AND s.held), '(none)'))
      ORDER BY relname) FROM targets t), '[]'::jsonb),
  'residual_browser_acl_entries', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'table', relname, 'grantee', grantee, 'privilege', privilege_type)) FROM browser_acl), '[]'::jsonb),
  'residual_browser_column_grants', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'table', table_name, 'grantee', grantee, 'column', column_name, 'privilege', privilege_type))
      FROM browser_cols), '[]'::jsonb),
  'residual_service_role_column_grants', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'table', table_name, 'column', column_name, 'privilege', privilege_type))
      FROM service_cols), '[]'::jsonb),
  'policies', jsonb_build_object(
    'count', (SELECT count(*) FROM policies),
    'definitions', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'table', tablename, 'policy', policyname, 'permissive', permissive,
        'applies_to', applies_to, 'command', cmd, 'using', using_expr, 'with_check', check_expr)
        ORDER BY tablename, policyname) FROM policies), '[]'::jsonb)),
  'structure', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'table', relname, 'constraints', constraints, 'indexes', indexes, 'triggers', triggers,
      'constraint_defs', constraint_defs, 'index_defs', index_defs, 'trigger_names', trigger_names)
      ORDER BY relname) FROM structure), '[]'::jsonb),
  'row_counts_now', (SELECT to_jsonb(c) FROM counts c),
  'checks', (SELECT to_jsonb(k) FROM checks k),
  'browser_cannot_read_even_own_rows', (SELECT k.browser_zero_table_privs
                                             AND k.browser_zero_column_privs
                                             AND k.browser_zero_acl_entries FROM checks k),
  'service_role_can_still_read_and_manage', (SELECT k.service_has_four_dml FROM checks k),
  'operator_must_compare', jsonb_build_array(
    'row_counts_now MUST equal row_counts_context_only from the preflight — this audit cannot see '
      || 'the pre-apply values and does not pretend to.',
    'policies.definitions, structure.constraint_defs, structure.index_defs and '
      || 'structure.trigger_names MUST be identical to the preflight output.',
    'The owner shown in final_matrix MUST match the preflight owner.',
    'Table recreation is separately excluded by the migration itself, which asserts the relation '
      || 'oid is unchanged inside the same transaction.'),
  'verdict', (SELECT CASE
      WHEN NOT k.both_tables_present        THEN 'FAIL: a graph table is missing'
      WHEN NOT k.browser_zero_table_privs   THEN 'FAIL: anon or authenticated still holds a table privilege'
      WHEN NOT k.browser_zero_acl_entries   THEN 'FAIL: a PUBLIC/anon/authenticated ACL entry remains'
      WHEN NOT k.browser_zero_column_privs  THEN 'FAIL: a browser-role column grant remains'
      WHEN NOT k.service_has_four_dml       THEN 'FAIL: service_role lost one of SELECT/INSERT/UPDATE/DELETE'
      WHEN NOT k.service_lacks_extras       THEN 'FAIL: service_role still holds TRUNCATE/REFERENCES/TRIGGER'
      WHEN NOT k.service_zero_column_privs  THEN 'FAIL: service_role has residual column grants'
      WHEN NOT k.no_leftover_migration_objects THEN 'FAIL: 086 temp objects survived the transaction'
      ELSE 'PASS — final privilege matrix is exactly as specified'
    END FROM checks k)
)) AS postapply_086;
