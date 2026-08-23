-- 075 PREFLIGHT — read-only. Run BEFORE applying migration 075. Every statement is a SELECT.
-- Answers the questions that decide whether 075 can be applied safely, rather than assuming them.

-- 1. Does the ledger already exist, and does it already hold rows? (Re-apply safety.)
SELECT '1. existing state' AS section, k AS item, v AS value
FROM (VALUES
  ('account_deletion_events exists', (SELECT CASE WHEN to_regclass('public.account_deletion_events') IS NULL THEN 'no' ELSE 'YES' END)),
  ('public.profiles exists',         (SELECT CASE WHEN to_regclass('public.profiles') IS NULL THEN 'NO — BLOCKER' ELSE 'yes' END)),
  ('auth.users exists',              (SELECT CASE WHEN to_regclass('auth.users') IS NULL THEN 'NO — BLOCKER' ELSE 'yes' END)),
  ('delete_user_account() exists',   (SELECT CASE WHEN to_regprocedure('public.delete_user_account()') IS NULL THEN 'NO — BLOCKER' ELSE 'yes' END)),
  ('purge function already exists',  (SELECT CASE WHEN to_regprocedure('public.purge_expired_account_deletion_events()') IS NULL THEN 'no' ELSE 'YES (re-apply)' END)),
  ('rows already beyond 7 years',    (SELECT CASE WHEN to_regclass('public.account_deletion_events') IS NULL THEN 'n/a — table absent'
                                                  ELSE 'see post-apply §6' END))
) t(k, v);

-- 2. Can we create a trigger on auth.users? Existing non-internal triggers prove the pattern works
--    here; the owner of auth.users tells us whether the migration role may add one.
SELECT '2. auth.users trigger feasibility' AS section,
       t.tgname AS existing_trigger,
       pg_get_userbyid(c.relowner) AS auth_users_owner,
       current_user AS applying_as
FROM pg_catalog.pg_class c
LEFT JOIN pg_catalog.pg_trigger t ON t.tgrelid = c.oid AND NOT t.tgisinternal
WHERE c.oid = to_regclass('auth.users');

-- 3. Inherited default privileges. If these grant ALL on TABLES, the REVOKE ALL in 075 is doing
--    real work — this is the defect that reached production three times (070, 072, 074).
SELECT '3. default privileges in schema public' AS section,
       pg_get_userbyid(d.defaclrole) AS granted_by,
       d.defaclobjtype AS obj_type,
       array_to_string(d.defaclacl, ' | ') AS default_acl
FROM pg_catalog.pg_default_acl d
JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname = 'public';

-- 4. Every relation 075's counts query reads must exist, or delete_user_account() will not compile.
SELECT '4. required relations' AS section, r AS relation,
       CASE WHEN to_regclass(r) IS NULL THEN 'MISSING — BLOCKER' ELSE 'present' END AS status
FROM unnest(ARRAY['public.messages','public.conversations','public.matches','public.intro_requests',
                  'public.meeting_credits','public.credit_transactions','public.meetings',
                  'public.notifications','public.profiles','public.waitlist']) AS r;

-- 5. Current grants on delete_user_account(), so PART 3's restated grants can be compared after.
SELECT '5. delete_user_account grants' AS section, role_name,
       has_function_privilege(role_name, 'public.delete_user_account()', 'EXECUTE') AS can_execute
FROM unnest(ARRAY['anon','authenticated','service_role']) AS role_name;

-- 6. Anything already deleting profiles or auth users that 075 should know about.
SELECT '6. existing triggers on the targets' AS section,
       c.relname AS on_table, t.tgname AS trigger_name, p.proname AS function_name
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal
  AND c.oid IN (to_regclass('public.profiles'), to_regclass('auth.users'))
ORDER BY c.relname, t.tgname;
