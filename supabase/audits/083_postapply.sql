-- 083 POST-APPLY — read-only. ONE top-level SELECT, one JSONB envelope. Run AFTER applying 083.
SELECT jsonb_pretty(jsonb_build_object(
  'audit', '083_postapply', 'generated_at', now(),
  'overall_verdict', CASE WHEN
      EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')
               AND prosrc LIKE '%INSERT INTO public.notifications%')
    AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='set_andrel_connector') = 1
    AND (SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)'))
        = 'p_member_id uuid, p_admin_id uuid, p_enabled boolean, p_reason text'
    AND (SELECT pg_get_function_result(oid) FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')) = 'jsonb'
    AND (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)'))
    AND (SELECT coalesce(array_to_string(proconfig, ','), '(NONE)') FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)'))
        IN ('search_path=', 'search_path=""')
    AND NOT has_function_privilege('anon','public.set_andrel_connector(uuid, uuid, boolean, text)','EXECUTE')
    AND NOT has_function_privilege('authenticated','public.set_andrel_connector(uuid, uuid, boolean, text)','EXECUTE')
    AND has_function_privilege('service_role','public.set_andrel_connector(uuid, uuid, boolean, text)','EXECUTE')
    AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='notifications_user_type_dedupe_key_uniq')
    AND (SELECT count(*) FROM public.notifications n WHERE n.type='andrel_connector_awarded'
          AND NOT EXISTS (SELECT 1 FROM public.member_recognition_events e
                           WHERE e.id::text = n.data->>'dedupeKey' AND e.member_id = n.user_id AND e.action='awarded')) = 0
    AND (SELECT count(*) FROM (SELECT user_id, data->>'dedupeKey' k FROM public.notifications
           WHERE type='andrel_connector_awarded' GROUP BY 1,2 HAVING count(*) > 1) d) = 0
    -- THE PRIVILEGE POSTURE THE CORRECTION ESTABLISHES
    AND (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.notifications'))
    -- anon and PUBLIC must hold NOTHING; authenticated exactly SELECT + UPDATE(read_at).
    AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) v
                     WHERE has_table_privilege('anon','public.notifications', v))
    AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['INSERT','DELETE','TRUNCATE','REFERENCES','TRIGGER']) v
                     WHERE has_table_privilege('authenticated','public.notifications', v))
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                     WHERE c.table_schema='public' AND c.table_name='notifications'
                       AND has_column_privilege('authenticated','public.notifications', c.column_name,'INSERT'))
    AND NOT EXISTS (SELECT 1 FROM pg_class c, unnest(coalesce(c.relacl, ARRAY[]::aclitem[])) a
                     WHERE c.oid = to_regclass('public.notifications')
                       AND a::text LIKE '=%' AND split_part(a::text, '/', 1) ~ '[aw]')
    AND NOT EXISTS (SELECT 1 FROM pg_policies pol WHERE pol.schemaname='public' AND pol.tablename='notifications'
                     AND pol.cmd IN ('INSERT','ALL')
                     AND (pol.roles IS NULL OR pol.roles::text[] && ARRAY['public','anon','authenticated']))
    -- and the legitimate member abilities survive
    AND has_table_privilege('authenticated','public.notifications','SELECT')
    AND has_column_privilege('authenticated','public.notifications','read_at','UPDATE')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                     WHERE c.table_schema='public' AND c.table_name='notifications'
                       AND c.column_name <> 'read_at'
                       AND has_column_privilege('authenticated','public.notifications', c.column_name,'UPDATE'))
    AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notifications' AND cmd='SELECT')
    AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notifications' AND cmd='UPDATE')
    AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.notifications') AND NOT tgisinternal)
    AND has_table_privilege('service_role','public.notifications','INSERT')
    AND has_table_privilege('service_role','public.notifications','UPDATE')
    AND has_table_privilege('service_role','public.notifications','SELECT')
    THEN 'PASS' ELSE 'BLOCKER' END,
  'writer', jsonb_build_object(
    'notifies', EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')
                         AND prosrc LIKE '%INSERT INTO public.notifications%'),
    'signature_unchanged', (SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)'))
        = 'p_member_id uuid, p_admin_id uuid, p_enabled boolean, p_reason text',
    'result_type', (SELECT pg_get_function_result(oid) FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')),
    'body_md5', (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')),
    'body_chars', (SELECT length(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')),
    'security_definer', (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')),
    'config', (SELECT coalesce(array_to_string(proconfig, ','), '(NONE)') FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')),
    'no_overload', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                     WHERE n.nspname='public' AND p.proname='set_andrel_connector') = 1,
    'acl_anon', has_function_privilege('anon','public.set_andrel_connector(uuid, uuid, boolean, text)','EXECUTE'),
    'acl_authenticated', has_function_privilege('authenticated','public.set_andrel_connector(uuid, uuid, boolean, text)','EXECUTE'),
    'acl_service_role', has_function_privilege('service_role','public.set_andrel_connector(uuid, uuid, boolean, text)','EXECUTE')),
  'notification_boundaries_unchanged', jsonb_build_object(
    'dedupe_unique_index_present', EXISTS (SELECT 1 FROM pg_indexes
        WHERE schemaname='public' AND indexname='notifications_user_type_dedupe_key_uniq'),
    'rls_enabled', (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.notifications')),
    'policy_count', (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='notifications'),
    'insert_policy_count', (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='notifications' AND cmd='INSERT'),
    'owner', (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = to_regclass('public.notifications')),
    'rls_forced', (SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass('public.notifications')),
    'raw_acl', (SELECT coalesce(array_to_string(relacl::text[], ','), '(NONE)') FROM pg_class WHERE oid = to_regclass('public.notifications')),
    'policies_full', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'name', policyname, 'cmd', cmd, 'roles', roles, 'using', qual, 'with_check', with_check) ORDER BY policyname), '[]'::jsonb)
      FROM pg_policies WHERE schemaname='public' AND tablename='notifications'),
    'grants', (SELECT jsonb_object_agg(g.role, jsonb_build_object(
        'select', has_table_privilege(g.role,'public.notifications','SELECT'),
        'insert', has_table_privilege(g.role,'public.notifications','INSERT'),
        'update', has_table_privilege(g.role,'public.notifications','UPDATE'),
        'delete', has_table_privilege(g.role,'public.notifications','DELETE'),
        'truncate', has_table_privilege(g.role,'public.notifications','TRUNCATE')))
      FROM unnest(ARRAY['anon','authenticated','service_role']) g(role)),
    'authenticated_column_update', (SELECT jsonb_object_agg(c.column_name,
          has_column_privilege('authenticated','public.notifications', c.column_name,'UPDATE'))
      FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name='notifications'),
    'anon_holds_nothing', NOT EXISTS (SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) v
                                       WHERE has_table_privilege('anon','public.notifications', v)),
    'public_holds_nothing', NOT EXISTS (SELECT 1 FROM pg_class c, unnest(coalesce(c.relacl, ARRAY[]::aclitem[])) a
                                         WHERE c.oid = to_regclass('public.notifications') AND a::text LIKE '=%'),
    'member_can_only_mark_read', has_column_privilege('authenticated','public.notifications','read_at','UPDATE')
        AND NOT has_column_privilege('authenticated','public.notifications','title','UPDATE')
        AND NOT has_column_privilege('authenticated','public.notifications','body','UPDATE')
        AND NOT has_column_privilege('authenticated','public.notifications','link','UPDATE')
        AND NOT has_column_privilege('authenticated','public.notifications','data','UPDATE')
        AND NOT has_column_privilege('authenticated','public.notifications','type','UPDATE')
        AND NOT has_column_privilege('authenticated','public.notifications','user_id','UPDATE')
        AND NOT has_column_privilege('authenticated','public.notifications','created_at','UPDATE'),
    'browser_callable_definers_inserting_notifications', (SELECT coalesce(jsonb_agg(p.proname ORDER BY p.proname), '[]'::jsonb)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.prosecdef AND p.prosrc LIKE '%INSERT INTO public.notifications%'
        AND (has_function_privilege('anon', p.oid,'EXECUTE') OR has_function_privilege('authenticated', p.oid,'EXECUTE'))),
    'dedupe_index_definition', (SELECT indexdef FROM pg_indexes
      WHERE schemaname='public' AND indexname='notifications_user_type_dedupe_key_uniq'),
    'triggers_on_notifications', (SELECT coalesce(jsonb_agg(tgname ORDER BY tgname), '[]'::jsonb)
      FROM pg_trigger WHERE tgrelid = to_regclass('public.notifications') AND NOT tgisinternal)),
  'runtime', jsonb_build_object(
    'badge_notifications', (SELECT count(*) FROM public.notifications WHERE type='andrel_connector_awarded'),
    'members_badged', (SELECT count(*) FROM public.profiles WHERE is_andrel_connector),
    'audit_events', (SELECT count(*) FROM public.member_recognition_events),
    'orphan_notifications_DEFECT', (SELECT count(*) FROM public.notifications n
        WHERE n.type='andrel_connector_awarded'
          AND NOT EXISTS (SELECT 1 FROM public.member_recognition_events e
                           WHERE e.id::text = n.data->>'dedupeKey' AND e.member_id = n.user_id AND e.action='awarded')),
    'duplicate_notifications_DEFECT', (SELECT count(*) FROM (
        SELECT user_id, data->>'dedupeKey' k FROM public.notifications
         WHERE type='andrel_connector_awarded' GROUP BY 1,2 HAVING count(*) > 1) d),
    'notifications_leaking_private_metadata_DEFECT', (SELECT count(*) FROM public.notifications
        WHERE type='andrel_connector_awarded' AND (data::text ~* 'reason|admin_id|referral|invit')),
    'note', 'immediately after apply badge_notifications, members_badged and audit_events are '
            'unchanged from before: 083 notifies nobody and awards nobody during apply.')
)) AS postapply_083;
