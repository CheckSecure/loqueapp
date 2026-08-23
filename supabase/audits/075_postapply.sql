-- 075 / 076 POST-APPLY — read-only. Run AFTER applying migrations 075 AND 076. Every statement is
-- a SELECT.
-- Each row is a PASS/FAIL assertion; anything not 'PASS' means the migration did not land as
-- intended and must be investigated before the deployment is considered complete.

-- 1. Privileges, which is where this codebase has been burned three times.
SELECT '1. privileges' AS section, k AS assertion,
       CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, detail
FROM (VALUES
  ('anon has no table privilege',
   NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_name='account_deletion_events' AND grantee='anon'),
   (SELECT coalesce(string_agg(privilege_type,','),'(none)') FROM information_schema.role_table_grants WHERE table_name='account_deletion_events' AND grantee='anon')),
  ('authenticated has no table privilege',
   NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_name='account_deletion_events' AND grantee='authenticated'),
   (SELECT coalesce(string_agg(privilege_type,','),'(none)') FROM information_schema.role_table_grants WHERE table_name='account_deletion_events' AND grantee='authenticated')),
  ('service_role has exactly INSERT,SELECT',
   (SELECT string_agg(privilege_type,',' ORDER BY privilege_type) FROM information_schema.role_table_grants WHERE table_name='account_deletion_events' AND grantee='service_role') = 'INSERT,SELECT',
   (SELECT coalesce(string_agg(privilege_type,',' ORDER BY privilege_type),'(none)') FROM information_schema.role_table_grants WHERE table_name='account_deletion_events' AND grantee='service_role')),
  ('service_role cannot UPDATE',     NOT has_table_privilege('service_role','public.account_deletion_events','UPDATE'),     'UPDATE'),
  ('service_role cannot DELETE',     NOT has_table_privilege('service_role','public.account_deletion_events','DELETE'),     'DELETE'),
  ('service_role cannot TRUNCATE',   NOT has_table_privilege('service_role','public.account_deletion_events','TRUNCATE'),   'TRUNCATE'),
  ('service_role cannot REFERENCES', NOT has_table_privilege('service_role','public.account_deletion_events','REFERENCES'), 'REFERENCES'),
  ('service_role cannot TRIGGER',    NOT has_table_privilege('service_role','public.account_deletion_events','TRIGGER'),    'TRIGGER')
) t(k, ok, detail);

-- 2. RLS: enabled, and no policy that could expose deletion history to a browser.
SELECT '2. row-level security' AS section, k AS assertion,
       CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, detail
FROM (VALUES
  ('RLS is enabled',
   (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.account_deletion_events')), 'relrowsecurity'),
  ('zero policies — no browser-readable history',
   (SELECT count(*) FROM pg_policies WHERE tablename='account_deletion_events') = 0,
   (SELECT coalesce(string_agg(policyname,','),'(none)') FROM pg_policies WHERE tablename='account_deletion_events'))
) t(k, ok, detail);

-- 3. Structure: no FK (it must outlive its subject), and the constraints that keep PII out.
SELECT '3. structure' AS section, k AS assertion,
       CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, detail
FROM (VALUES
  ('no foreign key on the ledger',
   (SELECT count(*) FROM pg_constraint WHERE conrelid = to_regclass('public.account_deletion_events') AND contype='f') = 0, 'contype=f'),
  ('event_key is unique (idempotency)',
   EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_deletion_events_event_key_uniq'), 'unique constraint'),
  ('count-shape constraint present',
   EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_deletion_events_counts_shape'), 'check constraint'),
  ('error_class restricted to the failed stage',
   EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_deletion_events_error_only_on_failure'), 'check constraint'),
  ('no column can hold email/name/body/ip/token',
   NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='account_deletion_events'
               AND column_name ~* 'email|name|body|content|ip_|token|payload|snapshot'),
   (SELECT coalesce(string_agg(column_name,','),'(none)') FROM information_schema.columns WHERE table_name='account_deletion_events'))
) t(k, ok, detail);

-- 4. Capture coverage: the triggers that make out-of-band deletion visible.
SELECT '4. capture coverage' AS section, k AS assertion,
       CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, detail
FROM (VALUES
  ('append-only trigger on the ledger',
   EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='account_deletion_events_append_only' AND NOT tgisinternal), 'row trigger'),
  ('truncate guard on the ledger',
   EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='account_deletion_events_no_truncate' AND NOT tgisinternal), 'statement trigger'),
  ('capture trigger on public.profiles',
   EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='capture_profile_deletion' AND NOT tgisinternal), 'PATH 3'),
  ('capture trigger on auth.users',
   EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='capture_auth_user_deletion' AND NOT tgisinternal), 'PATHS 4 and 5'),
  ('bulk-truncate capture on profiles',
   EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='capture_profiles_truncate' AND NOT tgisinternal), 'statement trigger'),
  ('all capture triggers are ENABLED',
   NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN
     ('capture_profile_deletion','capture_auth_user_deletion','capture_profiles_truncate',
      'account_deletion_events_append_only','account_deletion_events_no_truncate')
     AND tgenabled = 'D'),
   'tgenabled <> D')
) t(k, ok, detail);

-- 5. THE 076 CORRECTION — public.tg_account_deletion_events_append_only().
--    This is the one function whose grants migration 075 omitted: PostgreSQL grants EXECUTE on every
--    new function to PUBLIC by default, and Supabase's ALTER DEFAULT PRIVILEGES adds explicit
--    anon/authenticated/service_role entries on top. Production found it executable by all four.
--    Migration 076 revokes PUBLIC/anon/authenticated and keeps service_role.
--
--    PUBLIC is a PSEUDO-ROLE: has_function_privilege('PUBLIC', ...) raises
--    'role "PUBLIC" does not exist'. The ACL is inspected directly instead — a PUBLIC grant renders
--    as an aclitem whose grantee is empty, i.e. the text begins with '='.
SELECT '5. append-only function ACL (migration 076)' AS section, k AS assertion,
       CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, detail
FROM (VALUES
  ('function still exists',
   to_regprocedure('public.tg_account_deletion_events_append_only()') IS NOT NULL,
   'public.tg_account_deletion_events_append_only()'),
  ('PUBLIC cannot execute it (bare "=" ACL entry absent)',
   NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(coalesce(p.proacl, ARRAY[]::aclitem[])) a
               WHERE p.oid = to_regprocedure('public.tg_account_deletion_events_append_only()')
                 AND a::text LIKE '=%'),
   coalesce((SELECT array_to_string(proacl, ' | ') FROM pg_proc
              WHERE oid = to_regprocedure('public.tg_account_deletion_events_append_only()')),
            '(null acl = PostgreSQL default = PUBLIC CAN EXECUTE — FAIL)')),
  ('anon cannot execute it',
   NOT has_function_privilege('anon', to_regprocedure('public.tg_account_deletion_events_append_only()'), 'EXECUTE'),
   'anon'),
  ('authenticated cannot execute it',
   NOT has_function_privilege('authenticated', to_regprocedure('public.tg_account_deletion_events_append_only()'), 'EXECUTE'),
   'authenticated'),
  ('service_role CAN execute it',
   has_function_privilege('service_role', to_regprocedure('public.tg_account_deletion_events_append_only()'), 'EXECUTE'),
   'service_role'),
  ('still SECURITY DEFINER',
   (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.tg_account_deletion_events_append_only()')),
   'prosecdef'),
  -- HOW POSTGRESQL ACTUALLY STORES THIS. `SET search_path = ''` is recorded in pg_proc.proconfig as
  -- the single element  search_path=""  — the empty value is QUOTED, because an unquoted trailing
  -- '=' would be indistinguishable from a missing value. Comparing against 'search_path=' therefore
  -- fails against a correctly hardened function, which is exactly what production reported.
  -- Checked by exact ARRAY MEMBERSHIP rather than by flattening with array_to_string: membership is
  -- precise, and it cannot be satisfied by a longer string that merely contains the expected text.
  ('still pins an empty search_path',
   (SELECT 'search_path=""' = ANY(proconfig) FROM pg_proc
     WHERE oid = to_regprocedure('public.tg_account_deletion_events_append_only()')),
   coalesce((SELECT array_to_string(proconfig, ' | ') FROM pg_proc
              WHERE oid = to_regprocedure('public.tg_account_deletion_events_append_only()')), '(none)')),
  ('body UNCHANGED — 076 corrected privileges only',
   (SELECT prosrc LIKE '%is append-only; % is not permitted%'
       AND prosrc LIKE '%andrel.retention_purge%'
       AND prosrc LIKE '%make_interval(years => 7)%'
       AND prosrc LIKE '%insufficient_privilege%'
     FROM pg_proc WHERE oid = to_regprocedure('public.tg_account_deletion_events_append_only()')),
   'all four body markers present'),
  ('append-only trigger still present AND enabled',
   EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'account_deletion_events_append_only'
             AND NOT tgisinternal AND tgenabled <> 'D'),
   coalesce((SELECT tgenabled::text FROM pg_trigger WHERE tgname = 'account_deletion_events_append_only'), '(absent)')),
  ('truncate-guard trigger still present AND enabled',
   EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'account_deletion_events_no_truncate'
             AND NOT tgisinternal AND tgenabled <> 'D'),
   coalesce((SELECT tgenabled::text FROM pg_trigger WHERE tgname = 'account_deletion_events_no_truncate'), '(absent)'))
) t(k, ok, detail);

-- 5b. EVERY ledger function's ACL, so an omission like 076's cannot hide again. Any row where
--     public_can_execute is true, or anon/authenticated is true, is a FAIL.
SELECT '5b. all ledger function ACLs' AS section,
       p.proname AS function_name,
       p.prosecdef AS security_definer,
       coalesce(array_to_string(p.proconfig, ' | '), '(NONE — FAIL)') AS config,
       ('search_path=""' = ANY(p.proconfig))                    AS search_path_pinned_empty,
       EXISTS (SELECT 1 FROM unnest(coalesce(p.proacl, ARRAY[]::aclitem[])) a WHERE a::text LIKE '=%')
         OR p.proacl IS NULL                       AS public_can_execute,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
       has_function_privilege('service_role',  p.oid, 'EXECUTE') AS service_role_exec
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('record_account_deletion_event','tg_capture_account_deletion',
                    'tg_account_deletion_events_append_only','account_deletion_counts_ok',
                    'tg_capture_profiles_truncate','purge_expired_account_deletion_events',
                    'delete_user_account')
ORDER BY p.proname;
-- EXPECTED: search_path_pinned_empty = true on EVERY row; public_can_execute = false on EVERY row;
-- anon_exec = false on every row;
-- authenticated_exec = false EXCEPT delete_user_account, which must remain true (members delete
-- their own accounts through it).

-- 5c. Functions: SECURITY DEFINER hardening and exact execution grants.
SELECT '5. functions' AS section,
       p.proname AS function_name,
       p.prosecdef AS security_definer,
       coalesce(array_to_string(p.proconfig, ' | '), '(NONE — FAIL)') AS config,
       ('search_path=""' = ANY(p.proconfig))                    AS search_path_pinned_empty,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
       has_function_privilege('service_role',  p.oid, 'EXECUTE') AS service_role_exec
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('record_account_deletion_event','tg_capture_account_deletion',
                    'tg_account_deletion_events_append_only','account_deletion_counts_ok',
                    'tg_capture_profiles_truncate','delete_user_account')
ORDER BY p.proname;
-- EXPECTED: every row security_definer = true (except account_deletion_counts_ok, which is IMMUTABLE
-- sql and still pins search_path); search_path_pinned_empty = true and config = search_path="" on
-- every row; anon_exec = false everywhere;
-- authenticated_exec = false EXCEPT delete_user_account, which must remain true.

-- 6. RETENTION PURGE — exact signature, fixed boundary, no caller-controlled target.
SELECT '6. purge function' AS section, k AS assertion,
       CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, detail
FROM (VALUES
  ('purge function exists with the exact signature',
   to_regprocedure('public.purge_expired_account_deletion_events()') IS NOT NULL,
   'public.purge_expired_account_deletion_events()'),
  ('takes NO arguments — cannot be aimed at a member or a date',
   (SELECT pronargs FROM pg_proc WHERE oid = to_regprocedure('public.purge_expired_account_deletion_events()')) = 0,
   coalesce((SELECT pg_get_function_identity_arguments(to_regprocedure('public.purge_expired_account_deletion_events()'))), '')),
  ('returns only an aggregate count (bigint)',
   (SELECT pg_get_function_result(to_regprocedure('public.purge_expired_account_deletion_events()'))) = 'bigint',
   coalesce((SELECT pg_get_function_result(to_regprocedure('public.purge_expired_account_deletion_events()'))), '')),
  ('seven-year cutoff is FIXED IN THE BODY',
   (SELECT prosrc LIKE '%make_interval(years => 7)%' FROM pg_proc WHERE oid = to_regprocedure('public.purge_expired_account_deletion_events()')),
   'make_interval(years => 7)'),
  ('body contains no caller-controlled date, interval or target',
   NOT (SELECT prosrc ~ '\$[0-9]|p_(days|date|interval|years|user|email|id)' FROM pg_proc WHERE oid = to_regprocedure('public.purge_expired_account_deletion_events()')),
   'no parameter references'),
  -- Same storage representation as above: proconfig holds  search_path=""  , not  search_path= .
  ('SECURITY DEFINER with empty search_path',
   (SELECT prosecdef AND 'search_path=""' = ANY(proconfig) FROM pg_proc WHERE oid = to_regprocedure('public.purge_expired_account_deletion_events()')),
   coalesce((SELECT array_to_string(proconfig, ' | ') FROM pg_proc WHERE oid = to_regprocedure('public.purge_expired_account_deletion_events()')), '(none)')),
  ('PUBLIC cannot execute it',
   NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(coalesce(p.proacl, ARRAY[]::aclitem[])) a
               WHERE p.oid = to_regprocedure('public.purge_expired_account_deletion_events()') AND a::text LIKE '=%'),
   'no bare PUBLIC acl entry'),
  ('anon cannot execute it',
   NOT has_function_privilege('anon', to_regprocedure('public.purge_expired_account_deletion_events()'), 'EXECUTE'), 'anon'),
  ('authenticated cannot execute it',
   NOT has_function_privilege('authenticated', to_regprocedure('public.purge_expired_account_deletion_events()'), 'EXECUTE'), 'authenticated'),
  ('service_role CAN execute it',
   has_function_privilege('service_role', to_regprocedure('public.purge_expired_account_deletion_events()'), 'EXECUTE'), 'service_role'),
  ('append-only trigger independently re-checks the 7-year boundary',
   (SELECT prosrc LIKE '%make_interval(years => 7)%' FROM pg_proc WHERE proname = 'tg_account_deletion_events_append_only'),
   'second lock, so editing the purge alone cannot widen the window'),
  ('DELETE is gated on the purge marker',
   (SELECT prosrc LIKE '%andrel.retention_purge%' FROM pg_proc WHERE proname = 'tg_account_deletion_events_append_only'),
   'transaction-local marker')
) t(k, ok, detail);

-- 7. What the ledger currently holds against the stated period.
--    'beyond_stated_period' should be 0 on any run following a successful daily purge; a non-zero
--    value means the maintenance run has not executed since those rows expired, not that the policy
--    is wrong. Investigate the cron before assuming the boundary is broken.
SELECT '7. retention' AS section,
       (SELECT count(*) FROM public.account_deletion_events) AS rows_held,
       (SELECT min(occurred_at) FROM public.account_deletion_events) AS oldest_event,
       (SELECT count(*) FROM public.account_deletion_events WHERE occurred_at < now() - interval '7 years') AS beyond_stated_period,
       '7 years; purged automatically by public.purge_expired_account_deletion_events(), called '
       'once per daily engagement-reminders maintenance run' AS policy;
