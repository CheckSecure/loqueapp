-- 084 PREFLIGHT — read-only. Run in the Supabase SQL Editor BEFORE applying migration 084.
-- Creates nothing, writes nothing, locks nothing. One row out.
--
-- overall_verdict is the only thing to read:
--   READY                    apply 084.
--   ALREADY_APPLIED          both columns exist; 084 is idempotent but re-running is unnecessary.
--   BLOCKER                  do not apply. The reason column says why.
WITH cols AS (
  SELECT
    count(*) FILTER (WHERE attname = 'intro_guidance_enrolled_at')               AS enrolled_col,
    count(*) FILTER (WHERE attname = 'intro_first_batch_explainer_dismissed_at') AS dismissed_col
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.profiles'::pg_catalog.regclass AND NOT attisdropped AND attnum > 0
),
roles AS (
  SELECT count(*) AS n FROM pg_catalog.pg_roles WHERE rolname IN ('anon','authenticated','service_role')
),
posture AS (
  -- VALUE-BEARING privileges — these must already be absent (migrations 055 + 058). Any of them
  -- present is a genuine BLOCKER.
  SELECT
    pg_catalog.has_table_privilege('authenticated','public.profiles','SELECT') AS auth_select,
    pg_catalog.has_table_privilege('anon','public.profiles','SELECT')          AS anon_select,
    pg_catalog.has_table_privilege('authenticated','public.profiles','INSERT') AS auth_insert,
    pg_catalog.has_table_privilege('anon','public.profiles','INSERT')          AS anon_insert,
    pg_catalog.has_table_privilege('authenticated','public.profiles','UPDATE') AS auth_update,
    pg_catalog.has_table_privilege('anon','public.profiles','UPDATE')          AS anon_update,
    pg_catalog.has_table_privilege('authenticated','public.profiles','DELETE') AS auth_delete,
    pg_catalog.has_table_privilege('anon','public.profiles','DELETE')          AS anon_delete
),
inherited AS (
  -- NON-value-bearing privileges Supabase's default GRANT ALL leaves behind. Finding these is
  -- EXPECTED, and is exactly what 084 corrects — it is not a blocker. REFERENCES in particular
  -- reveals no value and changes none; it is revoked because it is unnecessary, not because it
  -- exposes anything.
  SELECT
    pg_catalog.has_table_privilege('authenticated','public.profiles','TRUNCATE')   AS auth_truncate,
    pg_catalog.has_table_privilege('anon','public.profiles','TRUNCATE')            AS anon_truncate,
    pg_catalog.has_table_privilege('authenticated','public.profiles','REFERENCES') AS auth_references,
    pg_catalog.has_table_privilege('anon','public.profiles','REFERENCES')          AS anon_references,
    pg_catalog.has_table_privilege('authenticated','public.profiles','TRIGGER')    AS auth_trigger,
    pg_catalog.has_table_privilege('anon','public.profiles','TRIGGER')             AS anon_trigger
),
svc AS (
  SELECT
    pg_catalog.has_table_privilege('service_role','public.profiles','SELECT') AS s_select,
    pg_catalog.has_table_privilege('service_role','public.profiles','INSERT') AS s_insert,
    pg_catalog.has_table_privilege('service_role','public.profiles','UPDATE') AS s_update,
    pg_catalog.has_table_privilege('service_role','public.profiles','DELETE') AS s_delete
),
colacl AS (
  -- Only value-bearing column privileges count as a problem.
  SELECT count(*) AS n
  FROM information_schema.column_privileges
  WHERE table_schema = 'public' AND table_name = 'profiles'
    AND column_name IN ('intro_guidance_enrolled_at','intro_first_batch_explainer_dismissed_at')
    AND grantee IN ('anon','authenticated','PUBLIC')
    AND privilege_type IN ('SELECT','INSERT','UPDATE')
),
pop AS (
  -- Sizing only. NEVER identities: a count, and nothing that could name a member.
  SELECT count(*) AS profiles_total,
         count(*) FILTER (WHERE profile_complete IS TRUE) AS profiles_complete
  FROM public.profiles
)
SELECT jsonb_pretty(jsonb_build_object(
  'checked_at', now(),
  'columns', jsonb_build_object(
    'intro_guidance_enrolled_at', (SELECT enrolled_col FROM cols) > 0,
    'intro_first_batch_explainer_dismissed_at', (SELECT dismissed_col FROM cols) > 0),
  'value_bearing_browser_privileges', jsonb_build_object(
    'authenticated', jsonb_build_object(
      'SELECT', (SELECT auth_select FROM posture), 'INSERT', (SELECT auth_insert FROM posture),
      'UPDATE', (SELECT auth_update FROM posture), 'DELETE', (SELECT auth_delete FROM posture)),
    'anon', jsonb_build_object(
      'SELECT', (SELECT anon_select FROM posture), 'INSERT', (SELECT anon_insert FROM posture),
      'UPDATE', (SELECT anon_update FROM posture), 'DELETE', (SELECT anon_delete FROM posture)),
    'expected', 'all false (migrations 055 + 058); any true is a BLOCKER'),
  'inherited_privileges_084_will_revoke', jsonb_build_object(
    'authenticated', jsonb_build_object(
      'TRUNCATE', (SELECT auth_truncate FROM inherited), 'REFERENCES', (SELECT auth_references FROM inherited),
      'TRIGGER', (SELECT auth_trigger FROM inherited)),
    'anon', jsonb_build_object(
      'TRUNCATE', (SELECT anon_truncate FROM inherited), 'REFERENCES', (SELECT anon_references FROM inherited),
      'TRIGGER', (SELECT anon_trigger FROM inherited)),
    'expected', 'true in production today. NOT a blocker — this is the posture 084 corrects. '
             || 'REFERENCES exposes no value and is revoked only because it is unnecessary.',
    'will_be_revoked_by_084', true),
  'service_role_privileges_084_preserves', jsonb_build_object(
    'SELECT', (SELECT s_select FROM svc), 'INSERT', (SELECT s_insert FROM svc),
    'UPDATE', (SELECT s_update FROM svc), 'DELETE', (SELECT s_delete FROM svc),
    'expected', 'all true; the server uses SELECT (138 sites), INSERT (1), UPDATE (32), DELETE (1)'),
  'browser_column_grants_on_new_columns', (SELECT n FROM colacl),
  'population', jsonb_build_object(
    'profiles_total', (SELECT profiles_total FROM pop),
    'profiles_complete', (SELECT profiles_complete FROM pop),
    'note', 'every one of these keeps intro_guidance_enrolled_at = NULL; 084 enrolls nobody'),
  'overall_verdict', CASE
    WHEN (SELECT n FROM roles) <> 3 THEN 'BLOCKER: one of anon/authenticated/service_role is missing'
    WHEN (SELECT auth_select FROM posture) OR (SELECT anon_select FROM posture)
      THEN 'BLOCKER: a browser role has SELECT on public.profiles (058 posture lost)'
    WHEN (SELECT auth_insert FROM posture) OR (SELECT anon_insert FROM posture)
      OR (SELECT auth_update FROM posture) OR (SELECT anon_update FROM posture)
      OR (SELECT auth_delete FROM posture) OR (SELECT anon_delete FROM posture)
      THEN 'BLOCKER: a browser role has INSERT/UPDATE/DELETE on public.profiles (055 posture lost)'
    WHEN NOT ((SELECT s_select FROM svc) AND (SELECT s_insert FROM svc)
          AND (SELECT s_update FROM svc) AND (SELECT s_delete FROM svc))
      THEN 'BLOCKER: service_role lacks a privilege the server needs on public.profiles'
    WHEN (SELECT n FROM colacl) > 0 THEN 'BLOCKER: a browser role holds a value-bearing column grant on the new columns'
    WHEN (SELECT enrolled_col FROM cols) > 0 AND (SELECT dismissed_col FROM cols) > 0 THEN 'ALREADY_APPLIED'
    WHEN (SELECT enrolled_col FROM cols) > 0 OR (SELECT dismissed_col FROM cols) > 0
      THEN 'BLOCKER: exactly one of the two columns exists — partial state, investigate before applying'
    ELSE 'READY'
  END
)) AS preflight;
