-- 084 POST-APPLY — read-only. Run AFTER applying migration 084. One row out.
--
-- overall_verdict:
--   PASS      both columns present, nullable, defaultless, zero members enrolled, posture intact.
--   FAIL      the reason says what is wrong. A non-zero enrollment count is the serious one:
--             it would mean historical members can be shown the one-time explainer.
WITH cols AS (
  SELECT attname,
         attnotnull AS not_null,
         atthasdef  AS has_default,
         pg_catalog.format_type(atttypid, atttypmod) AS type
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.profiles'::pg_catalog.regclass AND NOT attisdropped
    AND attname IN ('intro_guidance_enrolled_at','intro_first_batch_explainer_dismissed_at')
),
counts AS (
  SELECT count(*) AS profiles_total,
         count(*) FILTER (WHERE intro_guidance_enrolled_at IS NOT NULL)               AS enrolled,
         -- an enrolled member must ALSO be complete; a stamp on an incomplete profile would mean
         -- something other than the trigger wrote it
         count(*) FILTER (WHERE intro_guidance_enrolled_at IS NOT NULL AND profile_complete IS TRUE) AS enrolled_since_apply,
         count(*) FILTER (WHERE intro_first_batch_explainer_dismissed_at IS NOT NULL) AS dismissed
  FROM public.profiles
),
browser AS (
  -- ALL SEVEN table privileges, for both browser roles, must be false after 084.
  SELECT r.role, p.priv, pg_catalog.has_table_privilege(r.role, 'public.profiles', p.priv) AS held
  FROM (VALUES ('anon'),('authenticated')) AS r(role),
       (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) AS p(priv)
),
publicacl AS (
  -- PUBLIC is not a role has_table_privilege accepts; read it from the ACL (grantee oid 0).
  SELECT a.privilege_type AS priv
  FROM pg_catalog.pg_class c,
       LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
  WHERE c.oid = 'public.profiles'::pg_catalog.regclass AND a.grantee = 0
),
svc AS (
  SELECT p.priv, pg_catalog.has_table_privilege('service_role','public.profiles',p.priv) AS held
  FROM (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) AS p(priv)
),
trg AS (
  SELECT count(*) AS n,
         COALESCE((SELECT pg_catalog.pg_get_triggerdef(oid) FROM pg_catalog.pg_trigger
                    WHERE tgrelid='public.profiles'::pg_catalog.regclass AND NOT tgisinternal
                      AND pg_catalog.pg_get_triggerdef(oid) ILIKE '%intro_guidance_enroll%' LIMIT 1), '') AS def
  FROM pg_catalog.pg_trigger
  WHERE tgrelid='public.profiles'::pg_catalog.regclass AND NOT tgisinternal
    AND pg_catalog.pg_get_triggerdef(oid) ILIKE '%intro_guidance_enroll%'
),
trgfn AS (
  SELECT p.prosecdef, p.proconfig,
         pg_catalog.has_function_privilege('anon','public.tg_stamp_intro_guidance_enrollment()','EXECUTE') AS anon_exec,
         pg_catalog.has_function_privilege('authenticated','public.tg_stamp_intro_guidance_enrollment()','EXECUTE') AS auth_exec
  FROM pg_catalog.pg_proc p
  WHERE p.oid = pg_catalog.to_regprocedure('public.tg_stamp_intro_guidance_enrollment()')
),
colacl AS (
  SELECT count(*) AS n
  FROM information_schema.column_privileges
  WHERE table_schema = 'public' AND table_name = 'profiles'
    AND column_name IN ('intro_guidance_enrolled_at','intro_first_batch_explainer_dismissed_at')
    AND grantee IN ('anon','authenticated','PUBLIC')
    AND privilege_type IN ('SELECT','INSERT','UPDATE')   -- value-bearing only; REFERENCES is not exposure
),
emptypath AS (
  -- `SET search_path = ''` is STORED as search_path="" (quoted empty), not search_path=. Comparing
  -- against one encoding would fail a correctly-applied migration, so accept either.
  SELECT ARRAY['search_path=""','search_path='] AS ok
)
SELECT jsonb_pretty(jsonb_build_object(
  'checked_at', now(),
  'columns', (SELECT jsonb_agg(jsonb_build_object(
                'name', attname, 'type', type, 'not_null', not_null, 'has_default', has_default)
                ORDER BY attname) FROM cols),
  'profiles_total', (SELECT profiles_total FROM counts),
  'members_enrolled', (SELECT enrolled FROM counts),
  'members_dismissed', (SELECT dismissed FROM counts),
  'browser_privileges_on_profiles', (SELECT jsonb_object_agg(role, o) FROM (
      SELECT role, jsonb_object_agg(priv, held) AS o FROM browser GROUP BY role) z),
  'public_privileges_on_profiles', COALESCE((SELECT jsonb_agg(priv ORDER BY priv) FROM publicacl), '[]'::jsonb),
  'service_role_privileges', (SELECT jsonb_object_agg(priv, held) FROM svc),
  'expect_browser_privileges_all_false', true,
  'expect_public_privileges_empty', true,
  'expect_service_role_all_true', true,
  'browser_column_grants_on_new_columns', (SELECT n FROM colacl),
  'enrollment_authority', jsonb_build_object(
    'triggers_on_profiles', (SELECT n FROM trg),
    'definition', (SELECT def FROM trg),
    'function_security_definer', (SELECT prosecdef FROM trgfn),
    'function_search_path', (SELECT proconfig FROM trgfn),
    'anon_can_execute', (SELECT anon_exec FROM trgfn),
    'authenticated_can_execute', (SELECT auth_exec FROM trgfn)),
  'expect_enrollment_triggers', 1,
  'expect_columns', 2,
  'expect_members_enrolled_immediately_after_apply', 0,
  'expect_browser_column_grants', 0,
  'overall_verdict', CASE
    WHEN (SELECT count(*) FROM cols) <> 2 THEN 'FAIL: expected exactly 2 columns'
    WHEN EXISTS (SELECT 1 FROM cols WHERE type <> 'timestamp with time zone')
      THEN 'FAIL: a column has the wrong type'
    WHEN EXISTS (SELECT 1 FROM cols WHERE not_null OR has_default)
      THEN 'FAIL: a column is NOT NULL or carries a default (that would be a backfill)'
    WHEN (SELECT enrolled FROM counts) > (SELECT enrolled_since_apply FROM counts)
      THEN 'FAIL: more members are enrolled than have completed since 084 — a backfill occurred'
    WHEN (SELECT n FROM colacl) > 0 THEN 'FAIL: a browser role holds a column grant on the new columns'
    WHEN (SELECT n FROM trg) <> 1 THEN 'FAIL: expected exactly ONE enrollment trigger on public.profiles'
    WHEN (SELECT def FROM trg) NOT LIKE '%UPDATE OF profile_complete%' THEN 'FAIL: trigger is not scoped to profile_complete'
    WHEN (SELECT def FROM trg) NOT LIKE 'CREATE TRIGGER%BEFORE%' THEN 'FAIL: trigger is not a BEFORE trigger'
    WHEN (SELECT count(*) FROM trgfn) <> 1 THEN 'FAIL: the enrollment trigger function is absent'
    WHEN (SELECT prosecdef FROM trgfn) THEN 'FAIL: the trigger function is SECURITY DEFINER (needless privilege)'
    WHEN NOT (pg_catalog.array_to_string((SELECT proconfig FROM trgfn), ',') = ANY (SELECT unnest(ok) FROM emptypath)) THEN 'FAIL: trigger function has no empty search_path'
    WHEN (SELECT anon_exec OR auth_exec FROM trgfn) THEN 'FAIL: a browser role can EXECUTE the trigger function'
    WHEN EXISTS (SELECT 1 FROM browser WHERE held)
      THEN 'FAIL: a browser role still holds a privilege on public.profiles'
    WHEN EXISTS (SELECT 1 FROM publicacl)
      THEN 'FAIL: PUBLIC still holds a privilege on public.profiles'
    WHEN EXISTS (SELECT 1 FROM svc WHERE NOT held)
      THEN 'FAIL: service_role lost a privilege the server needs on public.profiles'
    ELSE 'PASS'
  END
)) AS postapply;
