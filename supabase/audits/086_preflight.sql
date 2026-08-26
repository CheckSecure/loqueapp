-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 086 PREFLIGHT — RELEASE B READINESS. READ-ONLY. ONE statement. NO identities.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Run before applying supabase/migrations/086_graph_tables_least_privilege.sql. It reports the
-- current privilege posture of the two connection-graph tables and everything the post-apply audit
-- must prove unchanged. It CHANGES NOTHING.
--
-- NO IDENTITIES. Row counts are emitted as context; no match row, user id, block relationship,
-- name, email or timestamp appears anywhere in the result.
--
-- ─── WHAT SQL CANNOT VERIFY, AND SO DOES NOT CLAIM ────────────────────────────────────────────
-- The Release A deployment gate is NOT checkable from inside the database. Whether commit
-- 42052b66671a04a0fd1d7937948d88ab2d5467ec is live, and whether Network / profile / Introductions /
-- Meetings / layout / Admin Members were smoke-tested, are facts about the running application.
-- They are surfaced below as an OPERATOR CONFIRMATION the reader must satisfy themselves — this
-- file will not pretend to have checked them. The verdict is BLOCKER-free only in the database
-- sense; the operator supplies the other half.
WITH targets AS (
  SELECT c.oid, c.relname, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl, c.relkind
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN ('matches', 'blocked_users')
),
roles AS (
  SELECT rolname FROM pg_catalog.pg_roles
  WHERE rolname IN ('anon', 'authenticated', 'service_role')
),
privs AS (
  SELECT t.relname, r.rolname, p.priv,
         pg_catalog.has_table_privilege(r.rolname, t.oid, p.priv) AS held
  FROM targets t CROSS JOIN roles r
  CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
                     ('TRUNCATE'),('REFERENCES'),('TRIGGER')) AS p(priv)
),
priv_rollup AS (
  SELECT relname, rolname,
         COALESCE(pg_catalog.string_agg(priv, ',' ORDER BY priv) FILTER (WHERE held), '(none)')
           AS effective
  FROM privs GROUP BY relname, rolname
),
acl AS (
  SELECT t.relname,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC'
              ELSE COALESCE((SELECT rolname FROM pg_catalog.pg_roles WHERE oid = a.grantee),
                            'oid:' || a.grantee::text) END AS grantee,
         a.privilege_type
  FROM targets t
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(t.relacl, pg_catalog.acldefault('r', t.relowner))) a
),
acl_rollup AS (
  SELECT relname, grantee,
         pg_catalog.string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS granted
  FROM acl GROUP BY relname, grantee
),
col_privs AS (
  -- EXPLICIT column grants only (pg_attribute.attacl). information_schema.column_privileges
  -- reports a TABLE-level grant once per column, which would badly overstate this number.
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
      OR x.grantee IN (SELECT oid FROM pg_catalog.pg_roles
                        WHERE rolname IN ('anon','authenticated','service_role')))
),
policies AS (
  SELECT p.tablename, p.policyname, p.permissive, p.roles::text AS applies_to, p.cmd,
         COALESCE(p.qual, '(none)') AS using_expr, COALESCE(p.with_check, '(none)') AS check_expr
  FROM pg_catalog.pg_policies p
  WHERE p.schemaname = 'public' AND p.tablename IN ('matches', 'blocked_users')
),
structure AS (
  SELECT t.relname,
    (SELECT count(*) FROM pg_catalog.pg_constraint k WHERE k.conrelid = t.oid) AS constraints,
    (SELECT count(*) FROM pg_catalog.pg_index i     WHERE i.indrelid = t.oid)  AS indexes,
    (SELECT count(*) FROM pg_catalog.pg_trigger g   WHERE g.tgrelid  = t.oid
                                                      AND NOT g.tgisinternal)  AS triggers,
    (SELECT COALESCE(pg_catalog.string_agg(k.conname || ': ' ||
              pg_catalog.pg_get_constraintdef(k.oid), E'\n' ORDER BY k.conname), '(none)')
       FROM pg_catalog.pg_constraint k WHERE k.conrelid = t.oid)                AS constraint_defs,
    (SELECT COALESCE(pg_catalog.string_agg(i.indexname || ': ' || i.indexdef, E'\n'
              ORDER BY i.indexname), '(none)')
       FROM pg_catalog.pg_indexes i
      WHERE i.schemaname = 'public' AND i.tablename = t.relname)                AS index_defs,
    (SELECT COALESCE(pg_catalog.string_agg(g.tgname, ', ' ORDER BY g.tgname), '(none)')
       FROM pg_catalog.pg_trigger g WHERE g.tgrelid = t.oid AND NOT g.tgisinternal) AS trigger_names
  FROM targets t
),
counts AS (
  SELECT (SELECT count(*) FROM public.matches)       AS matches_rows,
         (SELECT count(*) FROM public.blocked_users) AS blocked_users_rows
),
gate AS (
  SELECT
    (SELECT count(*) FROM targets WHERE relkind = 'r') = 2                       AS both_tables_exist,
    (SELECT count(*) FROM roles) = 3                                             AS all_roles_exist,
    -- service_role must ALREADY hold the four DML privileges the migration grants back, otherwise
    -- the revoke-then-grant would be a net change to server-side capability rather than a no-op.
    (SELECT bool_and(pg_catalog.has_table_privilege('service_role', t.oid, p.priv))
       FROM targets t CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) AS p(priv))
                                                                                 AS service_role_has_four_dml,
    -- the migration itself must not already be recorded / applied
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relname = '_m086_before')       AS migration_objects_absent,
    -- and the thing it is meant to fix must still be true, or there is nothing to do
    (SELECT bool_or(pg_catalog.has_table_privilege('authenticated', t.oid, 'SELECT')) FROM targets t)
                                                                                 AS authenticated_can_still_select
)
SELECT jsonb_pretty(jsonb_build_object(
  'generated_at', now(),
  'server_version', current_setting('server_version'),
  'tables', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'table', relname,
      'kind', relkind,
      'owner', COALESCE((SELECT rolname FROM pg_catalog.pg_roles WHERE oid = relowner), 'unknown'),
      'rls_enabled', relrowsecurity,
      'rls_forced', relforcerowsecurity) ORDER BY relname) FROM targets), '[]'::jsonb),
  'table_privileges_effective', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'table', relname, 'role', rolname, 'effective', effective)
      ORDER BY relname, rolname) FROM priv_rollup), '[]'::jsonb),
  'table_acl_entries', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'table', relname, 'grantee', grantee, 'granted', granted)
      ORDER BY relname, grantee) FROM acl_rollup), '[]'::jsonb),
  'column_privileges', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'table', table_name, 'grantee', grantee, 'column', column_name, 'privilege', privilege_type)
      ORDER BY table_name, grantee, column_name, privilege_type) FROM col_privs), '[]'::jsonb),
  'column_privilege_count', (SELECT count(*) FROM col_privs),
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
  'row_counts_context_only', (SELECT to_jsonb(c) FROM counts c),
  'database_gate', (SELECT to_jsonb(g) FROM gate g),
  'operator_confirmation_required', jsonb_build_array(
    'SQL CANNOT VERIFY ANY OF THESE. Confirm them yourself before applying 086:',
    '1. Release A commit 42052b66671a04a0fd1d7937948d88ab2d5467ec is DEPLOYED to production.',
    '2. Network, profile, Introductions, Meetings, dashboard layout and Admin Members were '
      || 'smoke-tested successfully on that deployment.',
    '3. No older deployment that still reads these tables as the member is serving traffic.',
    'If any of the three is not true, applying 086 will break member-facing pages.'),
  'verdict', (SELECT CASE
      WHEN NOT g.both_tables_exist          THEN 'BLOCKER: a graph table is missing'
      WHEN NOT g.all_roles_exist            THEN 'BLOCKER: anon / authenticated / service_role not all present'
      WHEN NOT g.service_role_has_four_dml  THEN 'BLOCKER: service_role does not already hold SELECT/INSERT/UPDATE/DELETE'
      WHEN NOT g.migration_objects_absent   THEN 'BLOCKER: 086 temp objects present — a prior run did not finish cleanly'
      WHEN NOT g.authenticated_can_still_select
        THEN 'ALREADY HARDENED: authenticated cannot SELECT; 086 would be a no-op (still safe to run)'
      ELSE 'READY (database side) — proceed only after the three operator confirmations above'
    END FROM gate g),
  'record_before_applying', jsonb_build_array(
    'Copy row_counts_context_only and the structure/policies blocks. The post-apply audit compares '
      || 'against the values YOU record here; it cannot see the pre-apply state itself.')
)) AS preflight_086;
