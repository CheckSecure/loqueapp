-- 082 POST-APPLY — read-only. ONE top-level SELECT, one JSONB envelope. Run AFTER applying 082.
-- Proves the columns, the constraint, the append-only audit, the writer's hardening, the member-view
-- allowlist, and that nothing was awarded on apply.
SELECT jsonb_pretty(jsonb_build_object(
  'audit', '082_postapply', 'generated_at', now(),
  'overall_verdict', CASE WHEN
      (SELECT count(*) FROM public.profiles
        WHERE (is_andrel_connector AND (andrel_connector_awarded_at IS NULL OR andrel_connector_awarded_by IS NULL))
           OR (NOT is_andrel_connector AND (andrel_connector_awarded_at IS NOT NULL OR andrel_connector_awarded_by IS NOT NULL))) = 0
    AND (SELECT count(*) FROM information_schema.columns
          WHERE table_name='public_profiles' AND column_name IN ('andrel_connector_awarded_at','andrel_connector_awarded_by')) = 0
    AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='public_profiles' AND column_name='is_andrel_connector')
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='profiles_andrel_connector_consistent_chk')
    AND (SELECT prosecdef FROM pg_proc WHERE proname='set_andrel_connector')
    AND NOT has_function_privilege('anon',          'public.set_andrel_connector(uuid, uuid, boolean, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.set_andrel_connector(uuid, uuid, boolean, text)', 'EXECUTE')
    AND has_function_privilege('service_role',      'public.set_andrel_connector(uuid, uuid, boolean, text)', 'EXECUTE')
    AND NOT has_table_privilege('authenticated','public.member_recognition_events','SELECT')
    AND NOT has_column_privilege('authenticated','public.profiles','is_andrel_connector','UPDATE')
    AND NOT has_table_privilege('anon','public.public_profiles','SELECT')
    AND has_table_privilege('authenticated','public.public_profiles','SELECT')
    AND (SELECT count(*) FROM pg_views v WHERE v.schemaname='public' AND v.definition LIKE '%member_recognition_events%') = 0
    AND (SELECT count(*) FROM pg_views v JOIN information_schema.columns c
           ON c.table_schema = v.schemaname AND c.table_name = v.viewname
          WHERE v.schemaname='public'
            AND c.column_name IN ('andrel_connector_awarded_at','andrel_connector_awarded_by')) = 0
    AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='can_discover_profile') = 1
    -- The pinned baselines are constants now, so these are decidable and belong in the verdict.
    AND (SELECT string_agg(a.attnum::text||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod), ',' ORDER BY a.attnum)
           FROM pg_attribute a WHERE a.attrelid = to_regclass('public.public_profiles')
            AND a.attnum > 0 AND NOT a.attisdropped)
        = '1:id:uuid,2:full_name:text,3:avatar_url:text,4:title:text,5:exact_job_title:text,6:company:text,7:company_id:uuid,8:role_type:text,9:seniority:text,10:location:text,11:bio:text,12:expertise:text,13:interests:text[],14:purposes:text[],15:intro_preferences:text[],16:mentorship_role:text,17:open_to_mentorship:boolean,18:open_to_business_solutions:boolean,19:current_focus_areas:jsonb,20:previous_roles:jsonb' || ',21:is_andrel_connector:boolean'
    AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.can_discover_profile(uuid)'))
        = '43624624c629e2d67978db0e9745ae1c'
    AND (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = to_regclass('public.public_profiles')) = 'postgres'
    THEN 'PASS' ELSE 'BLOCKER' END,
  'schema', jsonb_build_object(
    'is_andrel_connector_present', EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name='profiles' AND column_name='is_andrel_connector'),
    'boolean_not_null_default_false', EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name='profiles' AND column_name='is_andrel_connector'
          AND is_nullable='NO' AND column_default='false'),
    'awarded_at_nullable', EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name='profiles' AND column_name='andrel_connector_awarded_at' AND is_nullable='YES'),
    'awarded_by_nullable', EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name='profiles' AND column_name='andrel_connector_awarded_by' AND is_nullable='YES'),
    'consistency_check_present', EXISTS (SELECT 1 FROM pg_constraint
        WHERE conname='profiles_andrel_connector_consistent_chk'),
    'partial_index_present', EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='profiles_andrel_connector_idx'),
    'audit_table_present', to_regclass('public.member_recognition_events') IS NOT NULL,
    'audit_append_only_triggers', (SELECT count(*) FROM pg_trigger
        WHERE tgrelid = to_regclass('public.member_recognition_events') AND NOT tgisinternal),
    'audit_rls_enabled', (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.member_recognition_events')),
    'audit_policy_count', (SELECT count(*) FROM pg_policies WHERE tablename='member_recognition_events')),
  'writer', jsonb_build_object(
    'signature', 'public.set_andrel_connector(uuid, uuid, boolean, text)',
    'present', to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)') IS NOT NULL,
    'security_definer', (SELECT prosecdef FROM pg_proc WHERE proname='set_andrel_connector'),
    'config', (SELECT coalesce(array_to_string(proconfig, ','), '(NONE)') FROM pg_proc WHERE proname='set_andrel_connector'),
    'acl_public', EXISTS (SELECT 1 FROM pg_proc p, unnest(coalesce(p.proacl, ARRAY[]::aclitem[])) a
                           WHERE p.proname='set_andrel_connector' AND a::text LIKE '=%'),
    'acl_anon', has_function_privilege('anon','public.set_andrel_connector(uuid, uuid, boolean, text)','EXECUTE'),
    'acl_authenticated', has_function_privilege('authenticated','public.set_andrel_connector(uuid, uuid, boolean, text)','EXECUTE'),
    'acl_service_role', has_function_privilege('service_role','public.set_andrel_connector(uuid, uuid, boolean, text)','EXECUTE'),
    'no_overload', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                     WHERE n.nspname='public' AND p.proname='set_andrel_connector') = 1),
  -- ── THE VIEW DIFFERS ONLY BY THE APPENDED BOOLEAN ──────────────────────────────────────────
  -- The PRE-APPLY signature is pinned as a constant, so this PROVES rather than asserts that every
  -- pre-existing column kept its ordinal, name and type and that exactly one was appended. Nothing
  -- is supplied at run time: paste and run.
  'view_contract', (
    SELECT jsonb_build_object(
      'column_signature_now', sig.signature,
      -- The pinned PRE-APPLY production signature, embedded rather than supplied at run time.
      'column_signature_expected_pre', '1:id:uuid,2:full_name:text,3:avatar_url:text,4:title:text,5:exact_job_title:text,6:company:text,7:company_id:uuid,8:role_type:text,9:seniority:text,10:location:text,11:bio:text,12:expertise:text,13:interests:text[],14:purposes:text[],15:intro_preferences:text[],16:mentorship_role:text,17:open_to_mentorship:boolean,18:open_to_business_solutions:boolean,19:current_focus_areas:jsonb,20:previous_roles:jsonb',
      'appended_only_the_boolean',
          sig.signature = '1:id:uuid,2:full_name:text,3:avatar_url:text,4:title:text,5:exact_job_title:text,6:company:text,7:company_id:uuid,8:role_type:text,9:seniority:text,10:location:text,11:bio:text,12:expertise:text,13:interests:text[],14:purposes:text[],15:intro_preferences:text[],16:mentorship_role:text,17:open_to_mentorship:boolean,18:open_to_business_solutions:boolean,19:current_focus_areas:jsonb,20:previous_roles:jsonb' || ',21:is_andrel_connector:boolean',
      'column_count', sig.n,
      'columns', sig.detail,
      'definition_md5', md5(pg_get_viewdef(to_regclass('public.public_profiles'), true)),
      'definition_chars', length(pg_get_viewdef(to_regclass('public.public_profiles'), true)),
      'owner', (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = to_regclass('public.public_profiles')),
      'reloptions', (SELECT coalesce(array_to_string(reloptions, ','), '(NONE)') FROM pg_class WHERE oid = to_regclass('public.public_profiles')),
      'acl', (SELECT coalesce(array_to_string(relacl::text[], ','), '(NONE)') FROM pg_class WHERE oid = to_regclass('public.public_profiles')))
    FROM (
      SELECT string_agg(a.attnum::text || ':' || a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) AS signature,
             count(*) AS n,
             jsonb_agg(jsonb_build_object('ordinal', a.attnum, 'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum) AS detail
      FROM pg_attribute a
      WHERE a.attrelid = to_regclass('public.public_profiles') AND a.attnum > 0 AND NOT a.attisdropped
    ) sig),

  'can_discover_profile_untouched', jsonb_build_object(
    'present', to_regprocedure('public.can_discover_profile(uuid)') IS NOT NULL,
    'no_overload', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                     WHERE n.nspname='public' AND p.proname='can_discover_profile') = 1,
    'identity_args', (SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE oid = to_regprocedure('public.can_discover_profile(uuid)')),
    'body_md5', (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.can_discover_profile(uuid)')),
    'security_definer', (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.can_discover_profile(uuid)')),
    'config', (SELECT coalesce(array_to_string(proconfig, ','), '(NONE)') FROM pg_proc WHERE oid = to_regprocedure('public.can_discover_profile(uuid)')),
    'expected_body_md5_pre', '43624624c629e2d67978db0e9745ae1c',
    'unchanged', (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.can_discover_profile(uuid)'))
                 = '43624624c629e2d67978db0e9745ae1c'),

  -- No member-facing VIEW may expose the private award metadata or the recognition ledger. Checked
  -- across every view in the schema, not just public_profiles, so a helper view added later cannot
  -- quietly become the leak.
  'member_facing_leak_scan', jsonb_build_object(
    -- Join pg_views explicitly rather than matching names: information_schema.columns spans every
    -- schema the caller can see, and an unqualified name match picked up a system relation.
    'views_exposing_private_award_columns_DEFECT', (
      SELECT count(*) FROM pg_views v
       JOIN information_schema.columns c
         ON c.table_schema = v.schemaname AND c.table_name = v.viewname
       WHERE v.schemaname = 'public'
         AND c.column_name IN ('andrel_connector_awarded_at','andrel_connector_awarded_by')),
    'views_over_the_recognition_ledger_DEFECT', (
      SELECT count(*) FROM pg_views v
       WHERE v.schemaname='public' AND v.definition LIKE '%member_recognition_events%'),
    'browser_readable_views_exposing_reason_DEFECT', (
      SELECT count(*) FROM pg_views v
       JOIN information_schema.columns c
         ON c.table_schema = v.schemaname AND c.table_name = v.viewname
       WHERE v.schemaname = 'public' AND c.column_name = 'reason'
         AND has_table_privilege('authenticated',
               (quote_ident(v.schemaname)||'.'||quote_ident(v.viewname))::regclass, 'SELECT'))),

  'privacy', jsonb_build_object(
    'member_view_exposes_boolean', EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name='public_profiles' AND column_name='is_andrel_connector'),
    'private_columns_exposed_DEFECT', (SELECT count(*) FROM information_schema.columns
        WHERE table_name='public_profiles'
          AND column_name IN ('andrel_connector_awarded_at','andrel_connector_awarded_by')),
    'view_still_security_barrier', EXISTS (SELECT 1 FROM pg_class c
        WHERE c.oid = to_regclass('public.public_profiles') AND EXISTS (SELECT 1 FROM pg_options_to_table(c.reloptions) o WHERE o.option_name='security_barrier' AND lower(o.option_value) IN ('true','on','1'))),
    'view_still_definer', EXISTS (SELECT 1 FROM pg_class c
        WHERE c.oid = to_regclass('public.public_profiles') AND NOT EXISTS (SELECT 1 FROM pg_options_to_table(c.reloptions) o WHERE o.option_name='security_invoker' AND lower(o.option_value) IN ('true','on','1'))),
    'view_still_discovery_scoped', EXISTS (SELECT 1 FROM pg_views
        WHERE viewname='public_profiles' AND definition LIKE '%can_discover_profile%'),
    'authenticated_can_update_badge_DEFECT',
        has_column_privilege('authenticated','public.profiles','is_andrel_connector','UPDATE'),
    'authenticated_can_read_audit_DEFECT',
        has_table_privilege('authenticated','public.member_recognition_events','SELECT')),
  'runtime', jsonb_build_object(
    'members_badged', (SELECT count(*) FROM public.profiles WHERE is_andrel_connector),
    'audit_events', (SELECT count(*) FROM public.member_recognition_events),
    'inconsistent_badge_rows_DEFECT', (SELECT count(*) FROM public.profiles
        WHERE (is_andrel_connector AND (andrel_connector_awarded_at IS NULL OR andrel_connector_awarded_by IS NULL))
           OR (NOT is_andrel_connector AND (andrel_connector_awarded_at IS NOT NULL OR andrel_connector_awarded_by IS NOT NULL))),
    'badged_by_a_non_admin_DEFECT', (SELECT count(*) FROM public.profiles p
        WHERE p.is_andrel_connector
          AND NOT EXISTS (SELECT 1 FROM public.profiles a WHERE a.id = p.andrel_connector_awarded_by AND a.is_admin IS TRUE)),
    'note', 'immediately after apply members_badged and audit_events are 0: 082 awards nothing and '
            'backfills nothing.')
)) AS postapply_082;
