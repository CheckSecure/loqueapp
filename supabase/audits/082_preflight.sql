-- 082 PREFLIGHT — read-only. ONE top-level SELECT, one JSONB envelope. Run BEFORE applying 082.
-- No DML, DDL, transaction control, row locks, SELECT INTO, or side-effect-capable calls.
--
-- ─── THIS AUDIT PRODUCES THE BASELINE THE MIGRATION WILL PIN ──────────────────────────────────
-- The `baseline_*` fields below describe the privacy contract AS THIS SERVER RENDERS IT.
-- pg_get_viewdef() returns the parsed, normalized text, which varies with server version and with
-- how the view was last created, so no repository file can predict it. It has to be read from the
-- deployed database — here.
--
-- HOW THE VALUES ARE USED. They are NOT supplied to the migration at run time. Run this audit,
-- return its complete JSON output for review, and the reviewed values are then embedded as literal
-- constants in the final migration and post-apply audit. Those become single, self-contained
-- statements that can be pasted and run once in the Supabase SQL Editor.
--
-- That is deliberate. A run-time setting would have to be established inside the SAME transaction as
-- the migration, which a separately submitted SQL Editor query cannot guarantee; a baseline that
-- silently fails to arrive is worse than no baseline at all. Constants cannot go missing, and they
-- are reviewable in the artifact itself.
--
-- This audit therefore emits VALUES ONLY. It issues no operator commands and nothing here is
-- client-specific: it is one plain SELECT that runs anywhere psql or the SQL Editor runs.
--
-- Parses on a PRE-082 database: it never names a column 082 creates. PostgreSQL resolves column
-- references while parsing and no CASE can guard one, so anything needing the new column is read
-- through to_jsonb(t) ->> 'name', which names only the table.
WITH v AS (
  SELECT c.oid,
         pg_get_viewdef(c.oid, true)                                   AS viewdef,
         md5(pg_get_viewdef(c.oid, true))                              AS viewdef_md5,
         length(pg_get_viewdef(c.oid, true))                           AS viewdef_chars,
         pg_get_userbyid(c.relowner)                                   AS owner,
         coalesce(array_to_string(c.reloptions, ','), '(NONE)')        AS reloptions,
         coalesce(array_to_string(c.relacl::text[], ','), '(NONE)')    AS acl
  FROM pg_class c WHERE c.oid = to_regclass('public.public_profiles')
),
cols AS (
  SELECT string_agg(a.attnum::text || ':' || a.attname || ':' || format_type(a.atttypid, a.atttypmod),
                    ',' ORDER BY a.attnum) AS signature,
         count(*) AS n,
         jsonb_agg(jsonb_build_object('ordinal', a.attnum, 'name', a.attname,
                                      'type', format_type(a.atttypid, a.atttypmod))
                   ORDER BY a.attnum) AS detail
  FROM pg_attribute a
  WHERE a.attrelid = to_regclass('public.public_profiles') AND a.attnum > 0 AND NOT a.attisdropped
),
cdp AS (
  SELECT p.oid,
         pg_get_function_identity_arguments(p.oid) AS ident_args,
         pg_get_function_result(p.oid)             AS result_type,
         md5(p.prosrc)                             AS body_md5,
         length(p.prosrc)                          AS body_chars,
         p.prosecdef                               AS security_definer,
         coalesce(array_to_string(p.proconfig, ','), '(NONE)') AS config,
         pg_get_userbyid(p.proowner)               AS owner,
         (SELECT count(*) FROM pg_proc p2 JOIN pg_namespace n2 ON n2.oid = p2.pronamespace
           WHERE n2.nspname = 'public' AND p2.proname = 'can_discover_profile') AS signatures_deployed
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.can_discover_profile(uuid)')
),
expected AS (
  -- The VERIFIED production contract. Ordinals 19 and 20 are JSONB and only JSONB: migration 041
  -- created current_focus_areas as jsonb, and previous_roles stores an array of objects
  -- ({company,title,start_date,end_date}) that a text array cannot represent. This is pinned
  -- exactly — it deliberately does NOT accept text[] as an alternative, because accepting both
  -- would mean the audit could no longer tell a healthy database from a migrated-away one.
  SELECT '1:id:uuid,2:full_name:text,3:avatar_url:text,4:title:text,5:exact_job_title:text,6:company:text,7:company_id:uuid,8:role_type:text,9:seniority:text,10:location:text,11:bio:text,12:expertise:text,13:interests:text[],14:purposes:text[],15:intro_preferences:text[],16:mentorship_role:text,17:open_to_mentorship:boolean,18:open_to_business_solutions:boolean,19:current_focus_areas:jsonb,20:previous_roles:jsonb' AS col_signature
),
blockers AS (
  SELECT ARRAY_REMOVE(ARRAY[
    CASE WHEN (SELECT oid FROM v) IS NULL THEN 'VIEW_ABSENT' END,
    CASE WHEN (SELECT signature FROM cols) IS DISTINCT FROM (SELECT col_signature FROM expected)
         THEN 'VIEW_COLUMN_CONTRACT_DIFFERS' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE oid = to_regclass('public.public_profiles'))) o
                           WHERE o.option_name='security_barrier' AND lower(o.option_value) IN ('true','on','1'))
         THEN 'VIEW_NOT_SECURITY_BARRIER' END,
    CASE WHEN EXISTS (SELECT 1 FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE oid = to_regclass('public.public_profiles'))) o
                       WHERE o.option_name='security_invoker' AND lower(o.option_value) IN ('true','on','1'))
         THEN 'VIEW_IS_SECURITY_INVOKER' END,
    CASE WHEN has_table_privilege('anon','public.public_profiles','SELECT') THEN 'VIEW_READABLE_BY_ANON' END,
    CASE WHEN NOT has_table_privilege('authenticated','public.public_profiles','SELECT') THEN 'VIEW_NOT_READABLE_BY_AUTHENTICATED' END,
    CASE WHEN has_table_privilege('authenticated','public.public_profiles','UPDATE')
           OR has_table_privilege('authenticated','public.public_profiles','INSERT')
           OR has_table_privilege('authenticated','public.public_profiles','DELETE')
         THEN 'VIEW_WRITABLE_BY_BROWSER_ROLE' END,
    CASE WHEN (SELECT viewdef FROM v) NOT LIKE '%can_discover_profile%' THEN 'VIEW_NOT_DISCOVERY_SCOPED' END,
    CASE WHEN (SELECT oid FROM cdp) IS NULL THEN 'DISCOVERY_PREDICATE_ABSENT' END,
    CASE WHEN (SELECT signatures_deployed FROM cdp) <> 1 THEN 'DISCOVERY_PREDICATE_OVERLOADED' END,
    CASE WHEN (SELECT ident_args FROM cdp) IS DISTINCT FROM 'member_id uuid' THEN 'DISCOVERY_PREDICATE_ARGS_DIFFER' END,
    CASE WHEN (SELECT security_definer FROM cdp) IS DISTINCT FROM true THEN 'DISCOVERY_PREDICATE_NOT_DEFINER' END,
    CASE WHEN (SELECT config FROM cdp) NOT IN ('search_path=', 'search_path=""') THEN 'DISCOVERY_PREDICATE_SEARCH_PATH' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_schema='public' AND table_name='profiles' AND column_name='is_admin')
         THEN 'PROFILES_IS_ADMIN_ABSENT' END,
    -- ADMINISTRATOR PREREQUISITE. set_andrel_connector() refuses any actor without is_admin, so zero
    -- eligible administrators means the feature applies cleanly and is then unusable. That is a
    -- BLOCKER, not a note.
    CASE WHEN (SELECT count(*) FROM public.profiles WHERE is_admin IS TRUE) = 0
         THEN 'NO_ELIGIBLE_ADMINISTRATOR' END,
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema='public' AND table_name='profiles' AND column_name='is_andrel_connector')
         THEN 'ALREADY_APPLIED' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN 'SERVICE_ROLE_ABSENT' END
  ], NULL) AS list
)
SELECT jsonb_pretty(jsonb_build_object(
  'audit', '082_preflight', 'generated_at', now(),
  'overall_verdict', CASE WHEN cardinality((SELECT list FROM blockers)) = 0 THEN 'PASS' ELSE 'BLOCKER' END,
  'blocker_count', cardinality((SELECT list FROM blockers)),
  'blockers', to_jsonb((SELECT list FROM blockers)),

  -- ── THE VALUE THE MIGRATION REQUIRES ────────────────────────────────────────────────────────
  'baseline_view_md5', (SELECT viewdef_md5 FROM v),
  'baseline_view_owner', (SELECT owner FROM v),
  'baseline_view_acl', (SELECT acl FROM v),
  'baseline_view_columns', (SELECT signature FROM cols),
  'baseline_cdp_md5', (SELECT body_md5 FROM cdp),
  'baseline_note', 'Return this whole JSON document for review. The five baseline_* values above are '
                   'embedded as literal constants in the final migration and post-apply audit; '
                   'nothing is supplied to them at run time.',

  'public_profiles', jsonb_build_object(
    'present', (SELECT oid FROM v) IS NOT NULL,
    'definition_md5', (SELECT viewdef_md5 FROM v),
    'definition_chars', (SELECT viewdef_chars FROM v),
    'definition', (SELECT viewdef FROM v),
    'reloptions', (SELECT reloptions FROM v),
    'is_security_barrier', EXISTS (SELECT 1 FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE oid = to_regclass('public.public_profiles'))) o
                                    WHERE o.option_name='security_barrier' AND lower(o.option_value) IN ('true','on','1')),
    -- PostgreSQL 15+ records security_invoker; its ABSENCE is the definer posture 057 created.
    'security_invoker_recorded', EXISTS (SELECT 1 FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE oid = to_regclass('public.public_profiles'))) o
                                          WHERE o.option_name='security_invoker'),
    'is_definer', NOT EXISTS (SELECT 1 FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE oid = to_regclass('public.public_profiles'))) o
                               WHERE o.option_name='security_invoker' AND lower(o.option_value) IN ('true','on','1')),
    'owner', (SELECT owner FROM v),
    'acl', (SELECT acl FROM v),
    'grants_effective', jsonb_build_object(
      'anon_select', has_table_privilege('anon','public.public_profiles','SELECT'),
      'authenticated_select', has_table_privilege('authenticated','public.public_profiles','SELECT'),
      'authenticated_insert', has_table_privilege('authenticated','public.public_profiles','INSERT'),
      'authenticated_update', has_table_privilege('authenticated','public.public_profiles','UPDATE'),
      'authenticated_delete', has_table_privilege('authenticated','public.public_profiles','DELETE'),
      'service_role_select', has_table_privilege('service_role','public.public_profiles','SELECT')),
    'column_count', (SELECT n FROM cols),
    'column_signature_deployed', (SELECT signature FROM cols),
    'column_signature_expected', (SELECT col_signature FROM expected),
    'columns_match', (SELECT signature FROM cols) IS NOT DISTINCT FROM (SELECT col_signature FROM expected),
    'columns', (SELECT detail FROM cols),
    'discovery_scoped', (SELECT viewdef FROM v) LIKE '%can_discover_profile%',
    'depends_on', (SELECT coalesce(jsonb_agg(DISTINCT d.refobjid::regclass::text), '[]'::jsonb)
                     FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
                    WHERE r.ev_class = to_regclass('public.public_profiles')
                      AND d.refclassid = 'pg_class'::regclass
                      AND d.refobjid <> to_regclass('public.public_profiles')),
    'base_table_rls', (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.profiles')),
    'base_table_policies', (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='profiles')),

  'can_discover_profile', jsonb_build_object(
    'signature', 'public.can_discover_profile(uuid)',
    'present', (SELECT oid FROM cdp) IS NOT NULL,
    'signatures_deployed_for_name', (SELECT signatures_deployed FROM cdp),
    'identity_args_deployed', (SELECT ident_args FROM cdp),
    'identity_args_expected', 'member_id uuid',
    'result_type', (SELECT result_type FROM cdp),
    'body_md5', (SELECT body_md5 FROM cdp),
    'body_chars', (SELECT body_chars FROM cdp),
    'security_definer', (SELECT security_definer FROM cdp),
    'config', (SELECT config FROM cdp),
    'owner', (SELECT owner FROM cdp),
    'acl_anon', has_function_privilege('anon','public.can_discover_profile(uuid)','EXECUTE'),
    'acl_authenticated', has_function_privilege('authenticated','public.can_discover_profile(uuid)','EXECUTE')),

  -- Aggregate only. No email address, no name, no id is emitted for any administrator.
  'administrators', jsonb_build_object(
    'profiles_with_is_admin_true', (SELECT count(*) FROM public.profiles WHERE is_admin IS TRUE),
    'prerequisite_establishable', (SELECT count(*) FROM public.profiles WHERE is_admin IS TRUE) > 0,
    'note', 'The app guard authenticates by ADMIN_EMAIL while set_andrel_connector() requires '
            'profiles.is_admin IS TRUE on the acting row. Both must hold for the SAME account or the '
            'feature applies cleanly and every award is refused. Confirm out of band that the '
            'ADMIN_EMAIL account is among the count above; this audit does not read email addresses '
            'and changes no administrator row.'),

  'prerequisites', jsonb_build_object(
    'profiles_is_admin_present', EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='profiles' AND column_name='is_admin'),
    'badge_columns_already_added', EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='profiles' AND column_name='is_andrel_connector'),
    'audit_table_already_present', to_regclass('public.member_recognition_events') IS NOT NULL,
    'writer_already_present', to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)') IS NOT NULL,
    'roles_present', (SELECT jsonb_object_agg(rn, EXISTS (SELECT 1 FROM pg_roles WHERE rolname = rn))
                      FROM unnest(ARRAY['anon','authenticated','service_role']) rn)),

  'populations', jsonb_build_object(
    'members_already_badged', CASE
        WHEN EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema='public' AND table_name='profiles' AND column_name='is_andrel_connector')
        THEN (SELECT count(*) FROM public.profiles t WHERE to_jsonb(t) ->> 'is_andrel_connector' = 'true')
        ELSE 0 END,
    'total_profiles', (SELECT count(*) FROM public.profiles),
    'note', 'members_already_badged must be 0 before AND immediately after apply: 082 backfills '
            'nothing and awards nobody.')
)) AS preflight_082;
