-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- MIGRATION 100 — PREFLIGHT. STRICTLY READ-ONLY.
--
-- Every statement is a SELECT. No DML, DDL, lock, temp object, dynamic SQL or side-effecting call.
-- Running it changes nothing. It emits no address, name, user id or waitlist id — only catalog
-- metadata and unattributed counts — so its output is safe to paste into a review.
--
-- ─── WHAT THIS EXISTS TO ANSWER ───────────────────────────────────────────────────────────────
-- Migration 100 makes a BEFORE INSERT trigger the authorization boundary for profile creation. Two
-- things can route an INSERT around a row trigger entirely — a RULE, and table inheritance — and
-- neither is visible from the repository. A third, an out-of-band function that inserts profiles,
-- is equally invisible: this project's own record (docs/migrations/, and the header of
-- supabase/audits/phase1_live_schema_baseline.sql) states that objects have been created directly
-- in the SQL editor outside the migration workflow. Absence from git is not evidence of absence.
--
-- ─── RESULTS AT THE TIME OF WRITING (2026-09-09, production) ──────────────────────────────────
--   1  rules 0, inheritance children 0, relkind 'r'
--   2  0 out-of-band functions inserting profiles
--   3  five non-internal triggers (053 / 075 x2 / 084 / 099)
--   4  member_type: NOT NULL, DEFAULT 'professional'
--   5  profiles.email NOT NULL
--   6  139 profiles, all professional, 0 next
--   9  142 auth identities would be authorized to provision; 172 have no profile
-- Section 7's census is available only AFTER 100 is applied and is reported by its postapply block.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. BYPASS VECTORS. Both MUST be zero, and relkind MUST be 'r'. ───────────────────────────
-- A RULE can rewrite an INSERT into something the trigger never sees; a partition/inheritance child
-- accepts direct inserts that a parent trigger does not fire for. Migration 100 re-asserts both in
-- its own preconditions AND its postapply, so a later one cannot open the hole quietly.
SELECT '1. bypass vectors' AS section,
       (SELECT count(*) FROM pg_catalog.pg_rules
         WHERE schemaname = 'public' AND tablename = 'profiles')                  AS rules_on_profiles,
       (SELECT count(*) FROM pg_catalog.pg_inherits
         WHERE inhparent = 'public.profiles'::pg_catalog.regclass)                AS inheritance_children,
       (SELECT relkind FROM pg_catalog.pg_class
         WHERE oid = 'public.profiles'::pg_catalog.regclass)                      AS relkind;

-- ── 2. OUT-OF-BAND WRITERS. Expect zero rows. ────────────────────────────────────────────────
-- Function names only; no body is emitted.
SELECT '2. functions that insert profiles' AS section,
       n.nspname AS schema, p.proname AS function, p.prosecdef AS security_definer
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND p.prosrc ~* '(insert|upsert)[[:space:]]+into[[:space:]]+(public\.)?profiles'
ORDER BY 1, 2;

-- ── 3. TRIGGER TOPOLOGY AND FIRING ORDER. ────────────────────────────────────────────────────
-- tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE, 32 TRUNCATE.
-- BEFORE ROW triggers of the same kind fire in NAME order, so this ordering IS the firing order.
SELECT '3. triggers' AS section,
       t.tgname AS trigger_name, t.tgtype,
       CASE WHEN (t.tgtype & 2) <> 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
       CASE WHEN (t.tgtype & 1) <> 0 THEN 'ROW' ELSE 'STATEMENT' END AS level,
       concat_ws(' ',
         CASE WHEN (t.tgtype &  4) <> 0 THEN 'INSERT'   END,
         CASE WHEN (t.tgtype &  8) <> 0 THEN 'DELETE'   END,
         CASE WHEN (t.tgtype & 16) <> 0 THEN 'UPDATE'   END,
         CASE WHEN (t.tgtype & 32) <> 0 THEN 'TRUNCATE' END) AS events,
       p.proname AS function_name
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
WHERE t.tgrelid = 'public.profiles'::pg_catalog.regclass AND NOT t.tgisinternal
ORDER BY t.tgname COLLATE "C";

-- ── 4/5. THE TWO COLUMNS MIGRATION 100 DEPENDS ON. ───────────────────────────────────────────
-- member_type must still HAVE its default before 100 runs (100 is what removes it). email NOT NULL
-- decides whether a NULL address is refused by the boundary or by the column — the boundary gets
-- there first, and the harness asserts that ordering.
SELECT '4/5. columns' AS section, a.attname AS column_name, a.attnotnull AS not_null,
       pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS current_default
FROM pg_catalog.pg_attribute a
LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = 'public.profiles'::pg_catalog.regclass
  AND a.attname IN ('member_type', 'email')
ORDER BY a.attname;

-- ── 6. THE DISTRIBUTION MIGRATION 100 MUST NOT CHANGE. ───────────────────────────────────────
SELECT '6. communities' AS section, member_type, count(*) AS profiles
FROM public.profiles GROUP BY member_type ORDER BY member_type;

-- ── 8. BROWSER-ROLE CONTRACT (migrations 055/058) — 100 must leave it exactly as it is. ──────
SELECT '8. browser roles' AS section,
       pg_catalog.has_table_privilege('authenticated', 'public.profiles', 'INSERT') AS auth_insert,
       pg_catalog.has_table_privilege('authenticated', 'public.profiles', 'UPDATE') AS auth_update,
       pg_catalog.has_table_privilege('authenticated', 'public.profiles', 'SELECT') AS auth_select,
       pg_catalog.has_table_privilege('anon',          'public.profiles', 'SELECT') AS anon_select,
       pg_catalog.has_function_privilege('anon',          'public.resolve_intended_member_type(text)', 'EXECUTE') AS anon_resolver,
       pg_catalog.has_function_privilege('authenticated', 'public.resolve_intended_member_type(text)', 'EXECUTE') AS auth_resolver,
       pg_catalog.has_function_privilege('service_role',  'public.resolve_intended_member_type(text)', 'EXECUTE') AS svc_resolver;

-- ── 9. THE POPULATION THE BOUNDARY WILL GOVERN. Counts only. ─────────────────────────────────
-- Pre-aggregated per normalised address on BOTH sides before joining, so a duplicate identity
-- cannot multiply a row — the defect supabase/audits/onboarding_resume_audit.sql documents.
WITH au AS (
  SELECT lower(pg_catalog.btrim(u.email)) AS e, count(*) AS n,
         CASE WHEN count(*) = 1 THEN (array_agg(u.id))[1] END AS uid
  FROM auth.users u WHERE u.email IS NOT NULL GROUP BY 1),
wl AS (
  SELECT lower(pg_catalog.btrim(w.email)) AS e, count(*) AS total,
         count(*) FILTER (WHERE w.status = 'invited') AS inv,
         bool_or(w.status = 'revoked')  AS rev,
         bool_or(w.status = 'declined') AS dec,
         bool_or(w.status NOT IN ('invited','revoked','declined')) AS oth
  FROM public.waitlist w WHERE w.email IS NOT NULL GROUP BY 1)
SELECT '9. governed population' AS section,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = au.uid))
         AS profileless_auth_identities,
       count(*) FILTER (WHERE au.n = 1 AND wl.total = 1 AND wl.inv = 1
                          AND NOT wl.rev AND NOT wl.dec AND NOT wl.oth
                          AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = au.uid))
         AS would_be_authorized_to_provision
FROM au LEFT JOIN wl ON wl.e = au.e;
