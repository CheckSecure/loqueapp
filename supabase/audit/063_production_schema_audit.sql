-- 063_production_schema_audit.sql
--
-- ██ READ-ONLY. Run in the Supabase SQL Editor. Makes no changes and returns no member data. ██
--
-- WHY THIS EXISTS. Migration 063's disposable test fixture was reconciled against PostgREST's
-- OpenAPI schema (columns, types, nullability, defaults, PK/FK) and against the repository's
-- migration files. Neither source can see production-only objects: PostgREST cannot report indexes,
-- CHECK constraints, triggers, RLS policies or grants, and this project has previously carried
-- database objects that exist in production but not in the repo. This query reads pg_catalog
-- directly so the fixture can be compared against what production ACTUALLY has.
--
-- WHAT IT RETURNS. One row, one jsonb column named `audit`. Click the cell and copy the whole value.
--
-- THE SIX AUDITED RELATIONS ARE DECLARED EXACTLY ONCE, in the `params` CTE below, and every
-- dependency search derives its regex from that single array. An earlier draft hand-wrote the
-- pattern in three places and silently omitted `profiles` and `matches` from all three, so any
-- production-only function, policy or trigger touching those two tables would have gone unreported.
-- Nothing here repeats the list; if a name is added to `params`, every search follows automatically.
--
-- PRIVACY. Every result is catalog metadata: names, types, definitions, privileges. No table is
-- queried for rows, so no member data can appear. ONE caveat, flagged so it is not a surprise:
-- `pg_get_functiondef` returns the body of create_reciprocal_suggestion, which contains the literal
-- admin address 'bizdev91@gmail.com' in its eligibility filter. That address is already in the
-- repository (migration 050) and is yours, not a member's. If you would rather not paste it back,
-- redact that one line — it is not needed for the comparison.
--
-- SAFETY. SELECT only. No DDL, no DML, no function calls with side effects. Every catalog reference
-- is schema-qualified to pg_catalog, so it cannot be affected by search_path.
--
-- SIZE NOTE. Adding `profiles` to the dependency searches materially widens the results: profiles is
-- referenced by a great many functions. That is the point of the fix, not a defect — but expect the
-- `dependent_functions_by_body_text` array to be long.

WITH params AS (
  -- ██ THE SINGLE SOURCE OF TRUTH for which relations are audited and searched for. ██
  SELECT ARRAY['intro_requests','recommendation_batches','member_pairs',
               'profiles','matches','blocked_users']::text[] AS names
),
patt AS (
  -- One regex, derived from `names`, used by EVERY dependency search below.
  SELECT '\m(' || pg_catalog.array_to_string(names, '|') || ')\M' AS rx FROM params
),
requested AS (
  SELECT pg_catalog.unnest(names) AS relname FROM params
),
targets AS (
  SELECT c.oid, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
         c.relacl, c.relowner, pg_catalog.pg_get_userbyid(c.relowner) AS owner
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN (SELECT relname FROM requested)
),

-- 1. COLUMNS ────────────────────────────────────────────────────────────────────────────────────
cols AS (
  SELECT t.relname AS tbl,
         jsonb_agg(jsonb_build_object(
           'ordinal',   a.attnum,
           'name',      a.attname,
           'type',      pg_catalog.format_type(a.atttypid, a.atttypmod),
           'nullable',  NOT a.attnotnull,
           'not_null',  a.attnotnull,
           'default',   pg_catalog.pg_get_expr(ad.adbin, ad.adrelid, true),
           'identity',  CASE a.attidentity WHEN 'a' THEN 'ALWAYS'
                                           WHEN 'd' THEN 'BY DEFAULT' ELSE NULL END,
           'generated', CASE a.attgenerated WHEN 's' THEN 'STORED' ELSE NULL END,
           'collation', co.collname
         ) ORDER BY a.attnum) AS j
  FROM targets t
  JOIN pg_catalog.pg_attribute a
    ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef ad
    ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  LEFT JOIN pg_catalog.pg_collation co
    ON co.oid = a.attcollation AND co.collname <> 'default'
  GROUP BY t.relname
),

-- 2. CONSTRAINTS ────────────────────────────────────────────────────────────────────────────────
cons AS (
  SELECT t.relname AS tbl,
         jsonb_agg(jsonb_build_object(
           'name',       k.conname,
           'type',       CASE k.contype WHEN 'c' THEN 'check'
                                        WHEN 'f' THEN 'foreign_key'
                                        WHEN 'p' THEN 'primary_key'
                                        WHEN 'u' THEN 'unique'
                                        WHEN 't' THEN 'constraint_trigger'
                                        WHEN 'x' THEN 'exclusion'
                                        ELSE k.contype::text END,
           'validated',  k.convalidated,
           'deferrable', k.condeferrable,
           'deferred',   k.condeferred,
           'definition', pg_catalog.pg_get_constraintdef(k.oid, true),
           'references', CASE WHEN k.contype = 'f' THEN (
                           SELECT n2.nspname || '.' || c2.relname
                           FROM pg_catalog.pg_class c2
                           JOIN pg_catalog.pg_namespace n2 ON n2.oid = c2.relnamespace
                           WHERE c2.oid = k.confrelid) END
         ) ORDER BY k.contype, k.conname) AS j
  FROM targets t
  JOIN pg_catalog.pg_constraint k ON k.conrelid = t.oid
  GROUP BY t.relname
),

-- 3. INDEXES ────────────────────────────────────────────────────────────────────────────────────
idx AS (
  SELECT t.relname AS tbl,
         jsonb_agg(jsonb_build_object(
           'schema',     ns.nspname,
           'name',       ic.relname,
           'unique',     i.indisunique,
           'primary',    i.indisprimary,
           'exclusion',  i.indisexclusion,
           'valid',      i.indisvalid,
           'ready',      i.indisready,
           'live',       i.indislive,
           'replica_identity', i.indisreplident,
           'partial',    i.indpred IS NOT NULL,
           'predicate',  pg_catalog.pg_get_expr(i.indpred, i.indrelid, true),
           'expressions',pg_catalog.pg_get_expr(i.indexprs, i.indrelid, true),
           'definition', pg_catalog.pg_get_indexdef(i.indexrelid, 0, true)
         ) ORDER BY ic.relname) AS j
  FROM targets t
  JOIN pg_catalog.pg_index i  ON i.indrelid = t.oid
  JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_catalog.pg_namespace ns ON ns.oid = ic.relnamespace
  GROUP BY t.relname
),

-- 4. TRIGGERS ───────────────────────────────────────────────────────────────────────────────────
-- EVERY trigger, internal ones included, with its definition ALWAYS populated. An earlier draft
-- returned definition = NULL for internal triggers on the grounds that FK triggers are already
-- represented by their constraints. That silently removed rows from a catalog enumeration, which is
-- exactly what this audit exists to prevent. The `internal` flag lets you filter; the audit does not
-- filter for you.
trg AS (
  SELECT t.relname AS tbl,
         jsonb_agg(jsonb_build_object(
           'name',        g.tgname,
           'internal',    g.tgisinternal,
           'enabled',     CASE g.tgenabled WHEN 'O' THEN 'ORIGIN'
                                           WHEN 'D' THEN 'DISABLED'
                                           WHEN 'R' THEN 'REPLICA'
                                           WHEN 'A' THEN 'ALWAYS' END,
           'definition',  pg_catalog.pg_get_triggerdef(g.oid, true),
           'constraint',  CASE WHEN g.tgconstraint <> 0
                               THEN pg_catalog.pg_get_constraintdef(g.tgconstraint, true) END,
           'function',    fn.nspname || '.' || fp.proname,
           'function_identity_arguments', pg_catalog.pg_get_function_identity_arguments(fp.oid),
           'function_kind',               fp.prokind,
           'function_security_definer',   fp.prosecdef,
           'function_config',             fp.proconfig,
           'function_owner',              pg_catalog.pg_get_userbyid(fp.proowner)
         ) ORDER BY g.tgisinternal, g.tgname) AS j
  FROM targets t
  JOIN pg_catalog.pg_trigger g  ON g.tgrelid = t.oid
  JOIN pg_catalog.pg_proc fp    ON fp.oid = g.tgfoid
  JOIN pg_catalog.pg_namespace fn ON fn.oid = fp.pronamespace
  GROUP BY t.relname
),

-- 5. RLS POLICIES ───────────────────────────────────────────────────────────────────────────────
pol AS (
  SELECT t.relname AS tbl,
         jsonb_agg(jsonb_build_object(
           'name',       pl.polname,
           'command',    CASE pl.polcmd WHEN 'r' THEN 'SELECT'
                                        WHEN 'a' THEN 'INSERT'
                                        WHEN 'w' THEN 'UPDATE'
                                        WHEN 'd' THEN 'DELETE'
                                        WHEN '*' THEN 'ALL' END,
           'permissive', CASE WHEN pl.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
           'roles',      CASE WHEN pl.polroles = '{0}'::oid[] THEN to_jsonb(ARRAY['PUBLIC'])
                              ELSE to_jsonb(ARRAY(SELECT pg_catalog.pg_get_userbyid(r)
                                                  FROM pg_catalog.unnest(pl.polroles) r)) END,
           'using',      pg_catalog.pg_get_expr(pl.polqual, pl.polrelid, true),
           'with_check', pg_catalog.pg_get_expr(pl.polwithcheck, pl.polrelid, true)
         ) ORDER BY pl.polname) AS j
  FROM targets t
  JOIN pg_catalog.pg_policy pl ON pl.polrelid = t.oid
  GROUP BY t.relname
),

-- 6. TABLE PRIVILEGES ───────────────────────────────────────────────────────────────────────────
-- Two independent views of the same fact: the exploded ACL (complete truth, every grantee), and an
-- explicit per-role check for the four roles that matter. PUBLIC is checked as OID 0, which
-- has_table_privilege accepts. A role absent from the cluster yields JSON null rather than raising.
acl AS (
  SELECT t.relname AS tbl,
         jsonb_agg(jsonb_build_object(
           'grantee',   CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                             ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
           'privilege', a.privilege_type,
           'grantable', a.is_grantable
         ) ORDER BY 1) AS j
  FROM targets t
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    coalesce(t.relacl, pg_catalog.acldefault('r', t.relowner))
  ) a
  GROUP BY t.relname
),
privs AS (
  SELECT t.relname AS tbl,
         jsonb_object_agg(r.role_name, r.granted) AS j
  FROM targets t
  CROSS JOIN LATERAL (
    SELECT rn AS role_name,
           CASE WHEN rn = 'PUBLIC' OR pg_catalog.to_regrole(rn) IS NOT NULL THEN
             (SELECT coalesce(jsonb_agg(p ORDER BY p), '[]'::jsonb)
              FROM pg_catalog.unnest(
                ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
              WHERE pg_catalog.has_table_privilege(
                      CASE WHEN rn = 'PUBLIC' THEN 0::oid ELSE pg_catalog.to_regrole(rn)::oid END,
                      t.oid, p))
           END AS granted
    FROM pg_catalog.unnest(ARRAY['PUBLIC','anon','authenticated','service_role']) rn
  ) r
  GROUP BY t.relname
),

-- 7. FUNCTION METADATA ──────────────────────────────────────────────────────────────────────────
-- FULL IDENTITY for every overload. Argument ORDER is part of a PostgreSQL function's identity, so
-- CREATE OR REPLACE only replaces a function whose argument TYPE LIST matches exactly, in physical
-- order. Two prior reports disagreed about the live order of create_reciprocal_suggestion; this
-- section settles it from the catalog rather than from either report. `proargtypes_physical_order`
-- is the authoritative answer — it is the identity, independent of argument NAMES.
fn_rows AS (
  SELECT p.oid, p.proname, n.nspname, l.lanname, p.prokind, p.prosecdef, p.proconfig,
         p.provolatile, p.proowner, p.proacl, p.pronargs, p.pronargdefaults, p.proargnames,
         p.proargtypes, p.proargdefaults
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_catalog.pg_language  l ON l.oid = p.prolang
  WHERE n.nspname = 'public'
    AND p.proname IN ('create_reciprocal_suggestion','place_batch_rows','promote_queued_rows',
                      'expire_stale_reciprocal_pairs','pass_reciprocal_pair','mark_pair_known')
),
fn_json AS (
  SELECT f.proname,
         jsonb_build_object(
           'oid',                 f.oid::bigint,
           'regprocedure',        f.oid::regprocedure::text,
           'schema',              f.nspname,
           'name',                f.proname,
           'kind',                CASE f.prokind WHEN 'f' THEN 'function'
                                                 WHEN 'p' THEN 'procedure'
                                                 WHEN 'a' THEN 'aggregate'
                                                 WHEN 'w' THEN 'window' END,
           'pronargs',            f.pronargs,
           'proargtypes_physical_order',
                                  ARRAY(SELECT pg_catalog.format_type(t, NULL)
                                        FROM pg_catalog.unnest(f.proargtypes)
                                             WITH ORDINALITY AS x(t, ord)
                                        ORDER BY x.ord),
           'proargnames',         f.proargnames,
           'identity_arguments',  pg_catalog.pg_get_function_identity_arguments(f.oid),
           'arguments',           pg_catalog.pg_get_function_arguments(f.oid),
           'result',              pg_catalog.pg_get_function_result(f.oid),
           'pronargdefaults',     f.pronargdefaults,
           'default_expressions', pg_catalog.pg_get_expr(f.proargdefaults, 0::oid),
           'language',            f.lanname,
           'security_definer',    f.prosecdef,
           'config',              f.proconfig,
           'volatility',          CASE f.provolatile WHEN 'i' THEN 'IMMUTABLE'
                                                     WHEN 's' THEN 'STABLE'
                                                     WHEN 'v' THEN 'VOLATILE' END,
           'owner',               pg_catalog.pg_get_userbyid(f.proowner),
           'acl_raw',             f.proacl::text,
           'acl',                 (SELECT jsonb_agg(jsonb_build_object(
                                      'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                                                      ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
                                      'privilege', a.privilege_type,
                                      'grantable', a.is_grantable) ORDER BY 1)
                                   FROM pg_catalog.aclexplode(
                                     coalesce(f.proacl, pg_catalog.acldefault('f', f.proowner))) a),
           'execute_PUBLIC',        pg_catalog.has_function_privilege(0::oid, f.oid, 'EXECUTE'),
           'execute_anon',          CASE WHEN pg_catalog.to_regrole('anon') IS NOT NULL
                                    THEN pg_catalog.has_function_privilege('anon', f.oid, 'EXECUTE') END,
           'execute_authenticated', CASE WHEN pg_catalog.to_regrole('authenticated') IS NOT NULL
                                    THEN pg_catalog.has_function_privilege('authenticated', f.oid, 'EXECUTE') END,
           'execute_service_role',  CASE WHEN pg_catalog.to_regrole('service_role') IS NOT NULL
                                    THEN pg_catalog.has_function_privilege('service_role', f.oid, 'EXECUTE') END,
           'definition',          pg_catalog.pg_get_functiondef(f.oid)
         ) AS j
  FROM fn_rows f
),

-- 8a. CATALOG-RECORDED dependencies (pg_depend) ─────────────────────────────────────────────────
-- AUTHORITATIVE BUT NOT EXHAUSTIVE. PostgreSQL records a function's dependency on a relation only
-- for SQL-language functions with a parsed body (LANGUAGE sql ... BEGIN ATOMIC) and similar cases.
-- PL/pgSQL bodies are opaque strings to the parser, so a plpgsql function that reads these tables
-- records NO dependency here. That is why 8b exists. Neither section alone is exhaustive.
dep_funcs_catalog AS (
  SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object(
           'schema',              n.nspname,
           'name',                p.proname,
           'kind',                CASE p.prokind WHEN 'f' THEN 'function'
                                                 WHEN 'p' THEN 'procedure'
                                                 WHEN 'a' THEN 'aggregate'
                                                 WHEN 'w' THEN 'window' END,
           'regprocedure',        p.oid::regprocedure::text,
           'identity_arguments',  pg_catalog.pg_get_function_identity_arguments(p.oid),
           'security_definer',    p.prosecdef,
           'owner',               pg_catalog.pg_get_userbyid(p.proowner),
           'depends_on_relation', tc.relname,
           'depends_on_column',   CASE WHEN d.refobjsubid > 0 THEN (
                                    SELECT a.attname FROM pg_catalog.pg_attribute a
                                    WHERE a.attrelid = d.refobjid AND a.attnum = d.refobjsubid) END,
           'deptype',             d.deptype
         )), '[]'::jsonb) AS j
  FROM pg_catalog.pg_depend d
  JOIN pg_catalog.pg_proc p       ON p.oid = d.objid
  JOIN pg_catalog.pg_namespace n  ON n.oid = p.pronamespace
  JOIN pg_catalog.pg_class tc     ON tc.oid = d.refobjid
  WHERE d.classid    = 'pg_catalog.pg_proc'::regclass
    AND d.refclassid = 'pg_catalog.pg_class'::regclass
    AND d.refobjid IN (SELECT oid FROM targets)
),

-- 8b. BODY-TEXT reference matches ───────────────────────────────────────────────────────────────
-- BROADER BUT HEURISTIC. Catches PL/pgSQL and any production-only helper the repo never created.
-- It is a text search, so it can over-match (a table name inside a comment or a string literal) and
-- can under-match (a name assembled dynamically). Functions AND procedures are included.
dep_funcs_body AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'schema',              n.nspname,
           'name',                p.proname,
           'kind',                CASE p.prokind WHEN 'f' THEN 'function'
                                                 WHEN 'p' THEN 'procedure'
                                                 WHEN 'a' THEN 'aggregate'
                                                 WHEN 'w' THEN 'window' END,
           'regprocedure',        p.oid::regprocedure::text,
           'identity_arguments',  pg_catalog.pg_get_function_identity_arguments(p.oid),
           'security_definer',    p.prosecdef,
           'config',              p.proconfig,
           'owner',               pg_catalog.pg_get_userbyid(p.proowner),
           'mentions',            ARRAY(SELECT tname
                                        FROM pg_catalog.unnest((SELECT names FROM params)) tname
                                        WHERE p.prosrc ~* ('\m' || tname || '\M'))
         ) ORDER BY p.proname), '[]'::jsonb) AS j
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prokind IN ('f','p')
    AND p.prosrc ~* (SELECT rx FROM patt)
),

-- 8c. inbound foreign keys ──────────────────────────────────────────────────────────────────────
inbound_fks AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'from_table', sn.nspname || '.' || sc.relname,
           'to_table',   tn.nspname || '.' || tc.relname,
           'name',       k.conname,
           'validated',  k.convalidated,
           'definition', pg_catalog.pg_get_constraintdef(k.oid, true)
         ) ORDER BY sc.relname, k.conname), '[]'::jsonb) AS j
  FROM pg_catalog.pg_constraint k
  JOIN pg_catalog.pg_class sc     ON sc.oid = k.conrelid
  JOIN pg_catalog.pg_namespace sn ON sn.oid = sc.relnamespace
  JOIN pg_catalog.pg_class tc     ON tc.oid = k.confrelid
  JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
  WHERE k.contype = 'f'
    AND k.confrelid IN (SELECT oid FROM targets)
    AND k.conrelid NOT IN (SELECT oid FROM targets)
),

-- 8d. views / matviews / rules (pg_depend -> pg_rewrite) ────────────────────────────────────────
dep_views AS (
  SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object(
           'schema', dn.nspname,
           'name',   dc.relname,
           'kind',   CASE dc.relkind WHEN 'v' THEN 'view'
                                     WHEN 'm' THEN 'materialized_view'
                                     ELSE dc.relkind::text END,
           'depends_on', tc.relname
         )), '[]'::jsonb) AS j
  FROM pg_catalog.pg_depend d
  JOIN pg_catalog.pg_rewrite rw   ON rw.oid = d.objid
  JOIN pg_catalog.pg_class dc     ON dc.oid = rw.ev_class
  JOIN pg_catalog.pg_namespace dn ON dn.oid = dc.relnamespace
  JOIN pg_catalog.pg_class tc     ON tc.oid = d.refobjid
  WHERE d.classid    = 'pg_catalog.pg_rewrite'::regclass
    AND d.refclassid = 'pg_catalog.pg_class'::regclass
    AND d.refobjid IN (SELECT oid FROM targets)
    AND dc.oid NOT IN (SELECT oid FROM targets)
),

-- 8e. policies ANYWHERE mentioning an audited relation ──────────────────────────────────────────
dep_policies AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'on_table',  pn.nspname || '.' || pc.relname,
           'name',      pl.polname,
           'command',   pl.polcmd,
           'using',     pg_catalog.pg_get_expr(pl.polqual, pl.polrelid, true),
           'with_check',pg_catalog.pg_get_expr(pl.polwithcheck, pl.polrelid, true)
         ) ORDER BY pc.relname, pl.polname), '[]'::jsonb) AS j
  FROM pg_catalog.pg_policy pl
  JOIN pg_catalog.pg_class pc     ON pc.oid = pl.polrelid
  JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
  WHERE coalesce(pg_catalog.pg_get_expr(pl.polqual, pl.polrelid, true), '') ||
        coalesce(pg_catalog.pg_get_expr(pl.polwithcheck, pl.polrelid, true), '')
        ~* (SELECT rx FROM patt)
),

-- 8f. triggers ANYWHERE whose function body mentions an audited relation ────────────────────────
dep_triggers AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'on_table',   tn.nspname || '.' || tc.relname,
           'trigger',    g.tgname,
           'internal',   g.tgisinternal,
           'enabled',    g.tgenabled,
           'function',   fn2.nspname || '.' || fp.proname,
           'definition', pg_catalog.pg_get_triggerdef(g.oid, true)
         ) ORDER BY tc.relname, g.tgname), '[]'::jsonb) AS j
  FROM pg_catalog.pg_trigger g
  JOIN pg_catalog.pg_class tc      ON tc.oid = g.tgrelid
  JOIN pg_catalog.pg_namespace tn  ON tn.oid = tc.relnamespace
  JOIN pg_catalog.pg_proc fp       ON fp.oid = g.tgfoid
  JOIN pg_catalog.pg_namespace fn2 ON fn2.oid = fp.pronamespace
  WHERE fp.prosrc ~* (SELECT rx FROM patt)
)

SELECT jsonb_build_object(
  'audit_version',      '063.2',
  'generated_at',       now(),
  'server_version',     pg_catalog.version(),
  'server_version_num', pg_catalog.current_setting('server_version_num'),
  'current_database',   pg_catalog.current_database(),
  'audited_relations',  (SELECT to_jsonb(names) FROM params),
  'dependency_search_regex', (SELECT rx FROM patt),
  -- EVERY requested relation appears as a key, present or not. An earlier draft built this from the
  -- rows actually found, so a missing table would have vanished from the output entirely instead of
  -- being reported as missing.
  'tables', (
    SELECT jsonb_object_agg(r.relname,
      CASE WHEN t.oid IS NULL THEN jsonb_build_object('present', false)
           ELSE jsonb_build_object(
             'present',             true,
             'kind',                CASE t.relkind WHEN 'r' THEN 'table'
                                                   WHEN 'p' THEN 'partitioned_table'
                                                   ELSE t.relkind::text END,
             'owner',               t.owner,
             'rls_enabled',         t.relrowsecurity,
             'rls_forced',          t.relforcerowsecurity,
             'relacl_raw',          t.relacl::text,
             'columns',             coalesce(cols.j,  '[]'::jsonb),
             'constraints',         coalesce(cons.j,  '[]'::jsonb),
             'indexes',             coalesce(idx.j,   '[]'::jsonb),
             'triggers',            coalesce(trg.j,   '[]'::jsonb),
             'policies',            coalesce(pol.j,   '[]'::jsonb),
             'acl_exploded',        coalesce(acl.j,   '[]'::jsonb),
             'role_privileges',     coalesce(privs.j, '{}'::jsonb))
      END)
    FROM requested r
    LEFT JOIN targets t ON t.relname = r.relname
    LEFT JOIN cols  ON cols.tbl  = r.relname
    LEFT JOIN cons  ON cons.tbl  = r.relname
    LEFT JOIN idx   ON idx.tbl   = r.relname
    LEFT JOIN trg   ON trg.tbl   = r.relname
    LEFT JOIN pol   ON pol.tbl   = r.relname
    LEFT JOIN acl   ON acl.tbl   = r.relname
    LEFT JOIN privs ON privs.tbl = r.relname
  ),
  'missing_tables', (
    SELECT coalesce(jsonb_agg(r.relname ORDER BY r.relname), '[]'::jsonb)
    FROM requested r
    WHERE NOT EXISTS (SELECT 1 FROM targets t WHERE t.relname = r.relname)
  ),
  'functions', (SELECT coalesce(jsonb_agg(j ORDER BY j->>'name', j->>'regprocedure'), '[]'::jsonb)
                FROM fn_json),
  -- Isolated so the overload question cannot be missed. If this array has more than one element,
  -- the live function is overloaded ALREADY; if its single element's proargtypes_physical_order
  -- differs from migration 063's declaration, CREATE OR REPLACE would ADD an overload rather than
  -- replace, leaving the old permissive definition callable.
  'create_reciprocal_suggestion_overloads',
    (SELECT coalesce(jsonb_agg(j ORDER BY j->>'regprocedure'), '[]'::jsonb)
     FROM fn_json WHERE proname = 'create_reciprocal_suggestion'),
  'dependencies', jsonb_build_object(
    'catalog_recorded_function_dependencies', (SELECT j FROM dep_funcs_catalog),
    'body_text_function_matches',             (SELECT j FROM dep_funcs_body),
    'inbound_foreign_keys',                   (SELECT j FROM inbound_fks),
    'dependent_views',                        (SELECT j FROM dep_views),
    'dependent_policies',                     (SELECT j FROM dep_policies),
    'dependent_triggers',                     (SELECT j FROM dep_triggers),
    'note', 'catalog_recorded_* comes from pg_depend and is authoritative but NOT exhaustive: '
         || 'PL/pgSQL bodies are opaque to the parser and record no relation dependency. '
         || 'body_text_* is a regex over prosrc: broader, but it can over-match text in comments '
         || 'or literals and under-match dynamically assembled names. Neither is exhaustive alone.'
  )
) AS audit;
