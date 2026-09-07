-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- PHASE 1 — LIVE SCHEMA BASELINE. READ-ONLY. NO IDENTITIES. CHANGES NOTHING.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS. The repository's own record (docs/migrations/2026-05-11_conversations_rls_as_built.sql)
-- states that RLS was enabled and policies created directly in the Supabase SQL editor, outside the
-- git-tracked migration workflow. So supabase/migrations/ is NOT a faithful description of the live
-- database, and every claim about grants and policies made from reading those files is an inference.
--
-- Andrel Next segmentation will be built on top of exactly those grants and policies. Before any of
-- it is designed, the actual state has to be written down. This script produces that record.
--
-- ─── HOW TO RUN ───────────────────────────────────────────────────────────────────────────────
-- Supabase dashboard → SQL Editor → paste → Run. Each section returns one result set; export each
-- to CSV and commit them beside this file as
--   supabase/audits/phase1_live_schema_baseline_<section>.csv
-- Sections are independent; run them one at a time if the editor truncates.
--
-- ─── WHAT IT DELIBERATELY DOES NOT EMIT ───────────────────────────────────────────────────────
-- No member row, user id, email, name, match, block, message or meeting content appears anywhere.
-- Only catalog metadata and unattributed counts. Safe to commit to the repository.
--
-- ─── THE QUESTION THIS EXISTS TO ANSWER FIRST ─────────────────────────────────────────────────
-- Section 2 is the one that gates work: does public.meetings carry a participant-scoped SELECT
-- policy? No migration in this repository creates one, and migration 055 revoked only INSERT /
-- UPDATE / DELETE on that table — it explicitly left SELECT in place for the browser roles. If RLS
-- is off, or on with no SELECT policy and the grant still held, then any authenticated member can
-- read every meeting row in the product. Section 2 answers that; nothing should be assumed until it
-- has been run.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- SECTION 1 — TABLE PRIVILEGES AND RLS POSTURE FOR EVERY MEMBER-BEARING TABLE
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- `has_table_privilege` is used rather than information_schema.role_table_grants because it
-- resolves privileges the role holds by ANY route, including PUBLIC and role inheritance. A grant
-- to PUBLIC does not appear as a row for `authenticated` in role_table_grants, but it is very much
-- a privilege that role holds.
WITH targets AS (
  SELECT c.oid, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
         pg_catalog.pg_get_userbyid(c.relowner) AS owner,
         COALESCE(pg_catalog.array_to_string(c.relacl::text[], ' | '), '(default: owner only)') AS acl
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'v')
    AND c.relname IN (
      'profiles', 'public_profiles', 'matches', 'blocked_users', 'intro_requests',
      'conversations', 'messages', 'meetings', 'notifications', 'member_pairs',
      'batch_suggestions', 'introduction_batches', 'meeting_credits', 'credit_transactions',
      'opportunities', 'opportunity_candidates', 'opportunity_responses',
      'member_presence', 'waitlist', 'issue_reports', 'recruiter_activity'
    )
),
roles AS (
  SELECT rolname FROM pg_catalog.pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')
),
privs AS (
  SELECT t.relname, t.relkind, t.relrowsecurity, t.relforcerowsecurity, t.owner, t.acl,
         r.rolname, p.priv,
         pg_catalog.has_table_privilege(r.rolname, t.oid, p.priv) AS held
  FROM targets t
  CROSS JOIN roles r
  CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) AS p(priv)
)
SELECT
  relname                                                        AS object,
  CASE relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' END    AS kind,
  owner,
  relrowsecurity                                                 AS rls_enabled,
  relforcerowsecurity                                            AS rls_forced,
  rolname                                                        AS role,
  COALESCE(pg_catalog.string_agg(priv, ',' ORDER BY priv) FILTER (WHERE held), '(none)') AS effective_privileges,
  acl                                                            AS raw_acl
FROM privs
GROUP BY relname, relkind, relrowsecurity, relforcerowsecurity, owner, acl, rolname
ORDER BY relname, rolname;


-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- SECTION 2 — EVERY RLS POLICY ON THOSE TABLES  ← THE GATING QUESTION
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Read the `meetings` rows first.
--
--   EXPECTED-GOOD  : rls_enabled = true in Section 1, and a SELECT ('r') policy here whose
--                    using_expression constrains rows to requester_id/recipient_id = auth.uid().
--                    → the live state is already correct and only needs bringing under version
--                      control, verbatim, as a documented as-built migration.
--
--   NEEDS A FIX    : no row here for meetings with polcmd 'r'/'*', or rls_enabled = false, while
--                    Section 1 shows `authenticated` still holds SELECT.
--                    → every meeting row in the product is readable by any logged-in member, and a
--                      participant-scoped policy must be added.
--
-- Do not infer either outcome from the migration files. Run this.
SELECT
  c.relname                                                       AS object,
  p.polname                                                       AS policy,
  CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
                WHEN '*' THEN 'ALL' END                           AS command,
  p.polpermissive                                                 AS permissive,
  COALESCE(
    (SELECT pg_catalog.string_agg(pg_catalog.pg_get_userbyid(r), ',' ORDER BY pg_catalog.pg_get_userbyid(r))
     FROM unnest(p.polroles) AS r),
    'PUBLIC'
  )                                                               AS applies_to_roles,
  pg_catalog.pg_get_expr(p.polqual, p.polrelid)                   AS using_expression,
  pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)              AS with_check_expression
FROM pg_catalog.pg_policy p
JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'profiles', 'matches', 'blocked_users', 'intro_requests', 'conversations', 'messages',
    'meetings', 'notifications', 'member_pairs', 'batch_suggestions', 'introduction_batches',
    'meeting_credits', 'credit_transactions', 'opportunities', 'opportunity_candidates',
    'opportunity_responses', 'member_presence', 'waitlist', 'issue_reports', 'recruiter_activity'
  )
ORDER BY c.relname, p.polcmd, p.polname;


-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- SECTION 3 — TABLES WITH RLS ENABLED BUT NO POLICY AT ALL
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Two very different meanings, and the privilege column is what separates them:
--   service-role-only by design (member_pairs, rate_limit_counters, …) → correct, expect no policy
--   a member-facing table with a live browser grant                   → nothing is readable, or
--                                                                       everything is; investigate
SELECT
  c.relname                                                            AS object,
  c.relrowsecurity                                                     AS rls_enabled,
  pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT')     AS authenticated_can_select,
  pg_catalog.has_table_privilege('anon', c.oid, 'SELECT')              AS anon_can_select
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid)
ORDER BY authenticated_can_select DESC, c.relname;


-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- SECTION 4 — COLUMN-LEVEL GRANTS TO BROWSER ROLES
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- REVOKE ALL PRIVILEGES ON TABLE does not remove column-level grants (this is why migration 086
-- walks pg_attribute separately). A surviving GRANT SELECT (full_name) would keep a column readable
-- after a table-level revoke that looks complete. Anything returned here is worth explaining.
SELECT
  table_name   AS object,
  column_name  AS column,
  grantee      AS role,
  privilege_type
FROM information_schema.column_privileges
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
ORDER BY table_name, column_name, grantee, privilege_type;


-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- SECTION 5 — SECURITY-DEFINER FUNCTION ACLs AND HARDENING
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Three things must hold for every SECURITY DEFINER function reachable from a browser role:
-- an empty/pinned search_path, an ACL that does not include anon, and an intentional grant list.
-- `can_discover_profile` and `get_my_profile` are the two the entire privacy model rests on;
-- `create_reciprocal_suggestion` and `materialize_admin_pair` must be service_role only.
SELECT
  p.proname                                                              AS function,
  pg_catalog.pg_get_function_identity_arguments(p.oid)                   AS arguments,
  p.prosecdef                                                            AS security_definer,
  COALESCE(pg_catalog.array_to_string(p.proconfig, ','), '(none)')       AS config,
  pg_catalog.pg_get_userbyid(p.proowner)                                 AS owner,
  COALESCE(pg_catalog.array_to_string(p.proacl::text[], ' | '), '(default: PUBLIC EXECUTE)') AS acl,
  pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')            AS anon_can_execute,
  pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')   AS authenticated_can_execute,
  pg_catalog.md5(p.prosrc)                                               AS body_md5
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prokind = 'f'
ORDER BY p.prosecdef DESC, anon_can_execute DESC, p.proname;


-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- SECTION 6 — COLUMN INVENTORY FOR THE TABLES PHASE 2 WOULD TOUCH
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- The Phase 1 code review found `practice_areas` read in lib/messaging/icebreakers.ts with no
-- migration, no other query and no type anywhere in the repository, and `industry` read the same
-- way but selected for real in lib/introRequests/createAdminIntroPair.ts. This section settles both,
-- and gives Phase 2 the authoritative profiles column list to design against instead of a guess.
SELECT
  table_name  AS object,
  ordinal_position,
  column_name AS column,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('profiles', 'meetings', 'opportunities', 'opportunity_candidates', 'opportunity_responses')
ORDER BY table_name, ordinal_position;


-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- SECTION 7 — MEETINGS DATA SHAPE (COUNTS ONLY, NO IDENTITIES)
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Sizes the exposure the scheduleMeeting fix closes, and tells the operator whether any historical
-- cleanup is warranted. `unbacked` = a meeting whose two participants have NO match row in either
-- direction. Under the pre-fix code that was reachable through a forged form post; it is also
-- reachable innocently if a match was hard-deleted. A non-zero count is not proof of abuse — it is
-- the set worth eyeballing, and the set the Meetings-page discoverability gate now protects.
SELECT
  count(*)                                                                    AS meetings_total,
  count(*) FILTER (WHERE m.requester_id = m.recipient_id)                     AS self_scheduled,
  count(*) FILTER (WHERE NOT EXISTS (
    SELECT 1 FROM public.matches mm
    WHERE (mm.user_a_id = m.requester_id AND mm.user_b_id = m.recipient_id)
       OR (mm.user_a_id = m.recipient_id AND mm.user_b_id = m.requester_id)
  ))                                                                          AS unbacked_by_any_match,
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM public.blocked_users b
    WHERE (b.user_id = m.requester_id AND b.blocked_user_id = m.recipient_id)
       OR (b.user_id = m.recipient_id AND b.blocked_user_id = m.requester_id)
  ))                                                                          AS between_blocked_pairs
FROM public.meetings m;
