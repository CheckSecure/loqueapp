-- 083 PREFLIGHT — read-only. ONE top-level SELECT, one JSONB envelope. Run BEFORE applying 083.
-- No DML, DDL, transaction control, row locks, SELECT INTO, or side-effect-capable calls.
--
-- Reports the post-082 writer contract 083 pins, and the notification surface it will write into.
-- The notification GRANTS are reported rather than asserted: 083 does not change them, and this
-- audit is where an unexpected posture (a browser role holding INSERT, say) becomes visible before
-- anything is applied.
SELECT jsonb_pretty(jsonb_build_object(
  'audit', '083_preflight', 'generated_at', now(),
  -- ─── VERDICT SEMANTICS ────────────────────────────────────────────────────────────────────
  -- BLOCKER ALWAYS MEANS: DO NOT APPLY 083.
  --
  -- An inherited over-grant that 083 is designed and proven to remove is NOT a blocker — it is the
  -- reason to apply. Those appear under planned_remediations and do not increment blocker_count.
  -- Everything else — RLS off, a browser policy, an unexpected definer writer, writer drift, a
  -- missing index, a missing service-role capability, a trigger, or a privilege OUTSIDE the
  -- migration's explicit correction set — is a true blocker.
  'overall_verdict', CASE WHEN
      -- writer prerequisites
      to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)') IS NOT NULL
    AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='set_andrel_connector') = 1
    AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)'))
        = '2509f15ab6b2a976355fb4329bec1704'
    AND (SELECT length(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')) = 3277
    AND (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)'))
    AND (SELECT coalesce(array_to_string(proconfig, ','), '(NONE)') FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)'))
        IN ('search_path=', 'search_path=""')
    AND NOT has_function_privilege('anon','public.set_andrel_connector(uuid, uuid, boolean, text)','EXECUTE')
    AND NOT has_function_privilege('authenticated','public.set_andrel_connector(uuid, uuid, boolean, text)','EXECUTE')
    AND has_function_privilege('service_role','public.set_andrel_connector(uuid, uuid, boolean, text)','EXECUTE')
    AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')
                     AND prosrc LIKE '%INSERT INTO public.notifications%')
      -- surface prerequisites
    AND to_regclass('public.notifications') IS NOT NULL
    AND to_regclass('public.member_recognition_events') IS NOT NULL
    AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='notifications_user_type_dedupe_key_uniq')
    AND (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.notifications'))
      -- nothing 083 will not fix
    AND NOT EXISTS (SELECT 1 FROM pg_policies pol
                     WHERE pol.schemaname='public' AND pol.tablename='notifications'
                       AND pol.cmd IN ('INSERT','ALL')
                       AND (pol.roles IS NULL OR pol.roles::text[] && ARRAY['public','anon','authenticated']))
    AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notifications' AND cmd='SELECT')
    AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notifications' AND cmd='UPDATE')
    AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.notifications') AND NOT tgisinternal)
    AND NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.prosecdef AND p.prosrc LIKE '%INSERT INTO public.notifications%'
         AND p.proname <> 'set_andrel_connector'
         AND (has_function_privilege('anon', p.oid,'EXECUTE') OR has_function_privilege('authenticated', p.oid,'EXECUTE')
              OR EXISTS (SELECT 1 FROM unnest(coalesce(p.proacl, ARRAY[]::aclitem[])) a WHERE a::text LIKE '=%')))
      -- a COLUMN grant to a browser role outside read_at is a deliberate configuration 083 will not
      -- blanket-revoke, so it is a blocker rather than a planned remediation
    AND NOT EXISTS (
      SELECT 1 FROM pg_attribute a, unnest(coalesce(a.attacl, ARRAY[]::aclitem[])) g
       WHERE a.attrelid = to_regclass('public.notifications') AND a.attnum > 0 AND NOT a.attisdropped
         AND a.attname <> 'read_at'
         AND split_part(g::text, '=', 1) IN ('anon','authenticated'))
      -- service_role must keep what the active writers need
    AND has_table_privilege('service_role','public.notifications','SELECT')
    AND has_table_privilege('service_role','public.notifications','INSERT')
    AND has_table_privilege('service_role','public.notifications','UPDATE')
    THEN 'PASS' ELSE 'BLOCKER' END,

  'blocker_count', (SELECT cardinality(ARRAY_REMOVE(ARRAY[
    CASE WHEN to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)') IS NULL THEN 'WRITER_ABSENT' END,
    CASE WHEN (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname='public' AND p.proname='set_andrel_connector') <> 1 THEN 'WRITER_OVERLOADED' END,
    CASE WHEN (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)'))
              IS DISTINCT FROM '2509f15ab6b2a976355fb4329bec1704' THEN 'WRITER_DRIFT' END,
    CASE WHEN NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.notifications')) THEN 'NOTIFICATIONS_RLS_DISABLED' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='notifications_user_type_dedupe_key_uniq') THEN 'EXACT_ONCE_INDEX_MISSING' END,
    CASE WHEN EXISTS (SELECT 1 FROM pg_policies pol WHERE pol.schemaname='public' AND pol.tablename='notifications'
                       AND pol.cmd IN ('INSERT','ALL')
                       AND (pol.roles IS NULL OR pol.roles::text[] && ARRAY['public','anon','authenticated'])) THEN 'BROWSER_INSERT_OR_ALL_POLICY' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notifications' AND cmd='SELECT') THEN 'MEMBER_SELECT_POLICY_MISSING' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notifications' AND cmd='UPDATE') THEN 'MEMBER_UPDATE_POLICY_MISSING' END,
    CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.notifications') AND NOT tgisinternal) THEN 'UNEXPECTED_TRIGGER_ON_NOTIFICATIONS' END,
    CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname='public' AND p.prosecdef AND p.prosrc LIKE '%INSERT INTO public.notifications%'
                         AND p.proname <> 'set_andrel_connector'
                         AND (has_function_privilege('anon', p.oid,'EXECUTE') OR has_function_privilege('authenticated', p.oid,'EXECUTE')))
         THEN 'BROWSER_CALLABLE_DEFINER_INSERTS_NOTIFICATIONS' END,
    CASE WHEN EXISTS (SELECT 1 FROM pg_attribute a, unnest(coalesce(a.attacl, ARRAY[]::aclitem[])) g
                       WHERE a.attrelid = to_regclass('public.notifications') AND a.attnum > 0 AND NOT a.attisdropped
                         AND a.attname <> 'read_at' AND split_part(g::text, '=', 1) IN ('anon','authenticated'))
         THEN 'UNEXPECTED_BROWSER_COLUMN_GRANT' END,
    CASE WHEN NOT (has_table_privilege('service_role','public.notifications','SELECT')
                   AND has_table_privilege('service_role','public.notifications','INSERT')
                   AND has_table_privilege('service_role','public.notifications','UPDATE'))
         THEN 'SERVICE_ROLE_MISSING_REQUIRED_PRIVILEGE' END,
    CASE WHEN to_regclass('public.member_recognition_events') IS NULL THEN 'RECOGNITION_LEDGER_ABSENT' END,
    CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')
                       AND prosrc LIKE '%INSERT INTO public.notifications%') THEN 'ALREADY_APPLIED' END
  ], NULL))),
  'blockers', (SELECT to_jsonb(ARRAY_REMOVE(ARRAY[
    CASE WHEN to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)') IS NULL THEN 'WRITER_ABSENT' END,
    CASE WHEN (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname='public' AND p.proname='set_andrel_connector') <> 1 THEN 'WRITER_OVERLOADED' END,
    CASE WHEN (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)'))
              IS DISTINCT FROM '2509f15ab6b2a976355fb4329bec1704' THEN 'WRITER_DRIFT' END,
    CASE WHEN NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.notifications')) THEN 'NOTIFICATIONS_RLS_DISABLED' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='notifications_user_type_dedupe_key_uniq') THEN 'EXACT_ONCE_INDEX_MISSING' END,
    CASE WHEN EXISTS (SELECT 1 FROM pg_policies pol WHERE pol.schemaname='public' AND pol.tablename='notifications'
                       AND pol.cmd IN ('INSERT','ALL')
                       AND (pol.roles IS NULL OR pol.roles::text[] && ARRAY['public','anon','authenticated'])) THEN 'BROWSER_INSERT_OR_ALL_POLICY' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notifications' AND cmd='SELECT') THEN 'MEMBER_SELECT_POLICY_MISSING' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notifications' AND cmd='UPDATE') THEN 'MEMBER_UPDATE_POLICY_MISSING' END,
    CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.notifications') AND NOT tgisinternal) THEN 'UNEXPECTED_TRIGGER_ON_NOTIFICATIONS' END,
    CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname='public' AND p.prosecdef AND p.prosrc LIKE '%INSERT INTO public.notifications%'
                         AND p.proname <> 'set_andrel_connector'
                         AND (has_function_privilege('anon', p.oid,'EXECUTE') OR has_function_privilege('authenticated', p.oid,'EXECUTE')))
         THEN 'BROWSER_CALLABLE_DEFINER_INSERTS_NOTIFICATIONS' END,
    CASE WHEN EXISTS (SELECT 1 FROM pg_attribute a, unnest(coalesce(a.attacl, ARRAY[]::aclitem[])) g
                       WHERE a.attrelid = to_regclass('public.notifications') AND a.attnum > 0 AND NOT a.attisdropped
                         AND a.attname <> 'read_at' AND split_part(g::text, '=', 1) IN ('anon','authenticated'))
         THEN 'UNEXPECTED_BROWSER_COLUMN_GRANT' END,
    CASE WHEN NOT (has_table_privilege('service_role','public.notifications','SELECT')
                   AND has_table_privilege('service_role','public.notifications','INSERT')
                   AND has_table_privilege('service_role','public.notifications','UPDATE'))
         THEN 'SERVICE_ROLE_MISSING_REQUIRED_PRIVILEGE' END,
    CASE WHEN to_regclass('public.member_recognition_events') IS NULL THEN 'RECOGNITION_LEDGER_ABSENT' END,
    CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')
                       AND prosrc LIKE '%INSERT INTO public.notifications%') THEN 'ALREADY_APPLIED' END
  ], NULL))),

  -- ─── WHAT 083 IS DESIGNED AND PROVEN TO REMOVE ────────────────────────────────────────────
  -- Present here means "this is why you are applying 083", not "stop". Each entry is exactly one
  -- privilege the migration revokes, and the harness proves each removal.
  'planned_remediations', (SELECT to_jsonb(ARRAY_REMOVE(ARRAY[
    CASE WHEN has_table_privilege('anon','public.notifications','INSERT') THEN 'REVOKE_INSERT_FROM_anon' END,
    CASE WHEN has_table_privilege('anon','public.notifications','UPDATE') THEN 'REVOKE_UPDATE_FROM_anon' END,
    CASE WHEN has_table_privilege('anon','public.notifications','DELETE') THEN 'REVOKE_DELETE_FROM_anon' END,
    CASE WHEN has_table_privilege('anon','public.notifications','SELECT') THEN 'REVOKE_SELECT_FROM_anon' END,
    CASE WHEN has_table_privilege('authenticated','public.notifications','INSERT') THEN 'REVOKE_INSERT_FROM_authenticated' END,
    CASE WHEN has_table_privilege('authenticated','public.notifications','DELETE') THEN 'REVOKE_DELETE_FROM_authenticated' END,
    CASE WHEN has_table_privilege('authenticated','public.notifications','TRUNCATE') THEN 'REVOKE_TRUNCATE_FROM_authenticated' END,
    CASE WHEN has_table_privilege('authenticated','public.notifications','UPDATE') THEN 'NARROW_UPDATE_TO_read_at_FOR_authenticated' END,
    CASE WHEN EXISTS (SELECT 1 FROM pg_class c, unnest(coalesce(c.relacl, ARRAY[]::aclitem[])) a
                       WHERE c.oid = to_regclass('public.notifications') AND a::text LIKE '=%') THEN 'REVOKE_ALL_FROM_PUBLIC' END
  ], NULL))),
  'planned_remediation_count', (SELECT cardinality(ARRAY_REMOVE(ARRAY[
    CASE WHEN has_table_privilege('anon','public.notifications','INSERT') THEN 'x' END,
    CASE WHEN has_table_privilege('anon','public.notifications','UPDATE') THEN 'x' END,
    CASE WHEN has_table_privilege('anon','public.notifications','DELETE') THEN 'x' END,
    CASE WHEN has_table_privilege('anon','public.notifications','SELECT') THEN 'x' END,
    CASE WHEN has_table_privilege('authenticated','public.notifications','INSERT') THEN 'x' END,
    CASE WHEN has_table_privilege('authenticated','public.notifications','DELETE') THEN 'x' END,
    CASE WHEN has_table_privilege('authenticated','public.notifications','TRUNCATE') THEN 'x' END,
    CASE WHEN has_table_privilege('authenticated','public.notifications','UPDATE') THEN 'x' END,
    CASE WHEN EXISTS (SELECT 1 FROM pg_class c, unnest(coalesce(c.relacl, ARRAY[]::aclitem[])) a
                       WHERE c.oid = to_regclass('public.notifications') AND a::text LIKE '=%') THEN 'x' END
  ], NULL))),

  -- The exact transition, so the operator compares rather than trusts.
  'grant_transition', jsonb_build_object(
    'current_raw_acl', (SELECT coalesce(array_to_string(relacl::text[], ','), '(NONE)') FROM pg_class WHERE oid = to_regclass('public.notifications')),
    'current_table_privileges', (SELECT jsonb_object_agg(g.role, jsonb_build_object(
        'select', has_table_privilege(g.role,'public.notifications','SELECT'),
        'insert', has_table_privilege(g.role,'public.notifications','INSERT'),
        'update', has_table_privilege(g.role,'public.notifications','UPDATE'),
        'delete', has_table_privilege(g.role,'public.notifications','DELETE'),
        'truncate', has_table_privilege(g.role,'public.notifications','TRUNCATE'),
        'references', has_table_privilege(g.role,'public.notifications','REFERENCES'),
        'trigger', has_table_privilege(g.role,'public.notifications','TRIGGER')))
      FROM unnest(ARRAY['anon','authenticated','service_role']) g(role)),
    'current_authenticated_column_update', (SELECT jsonb_object_agg(c.column_name,
        has_column_privilege('authenticated','public.notifications', c.column_name,'UPDATE'))
      FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name='notifications'),
    'planned_statements', to_jsonb(ARRAY[
      'REVOKE ALL ON public.notifications FROM PUBLIC',
      'REVOKE ALL ON public.notifications FROM anon',
      'REVOKE ALL ON public.notifications FROM authenticated',
      'GRANT SELECT ON public.notifications TO authenticated',
      'GRANT UPDATE (read_at) ON public.notifications TO authenticated']),
    'expected_after_083', jsonb_build_object(
      'PUBLIC', 'no privileges',
      'anon', 'no privileges',
      'authenticated', 'SELECT + UPDATE(read_at) only',
      'service_role', 'unchanged (SELECT, INSERT, UPDATE required by the active writers)')),

  'writer', jsonb_build_object(
    'signature', 'public.set_andrel_connector(uuid, uuid, boolean, text)',
    'present', to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)') IS NOT NULL,
    'signatures_deployed_for_name', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                                      WHERE n.nspname='public' AND p.proname='set_andrel_connector'),
    'identity_args_expected', 'p_member_id uuid, p_admin_id uuid, p_enabled boolean, p_reason text',
    'identity_args_deployed', (SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')),
    'result_type_expected', 'jsonb',
    'result_type_deployed', (SELECT pg_get_function_result(oid) FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')),
    'body_md5_expected', '2509f15ab6b2a976355fb4329bec1704',
    'body_md5_deployed', (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')),
    'body_chars_expected', 3277,
    'body_chars_deployed', (SELECT length(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')),
    'body_octets_deployed', (SELECT octet_length(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')),
    'security_definer', (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')),
    'config', (SELECT coalesce(array_to_string(proconfig, ','), '(NONE)') FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')),
    'owner', (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')),
    'acl_public', EXISTS (SELECT 1 FROM pg_proc p, unnest(coalesce(p.proacl, ARRAY[]::aclitem[])) a
                           WHERE p.oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)') AND a::text LIKE '=%'),
    'acl_anon', has_function_privilege('anon','public.set_andrel_connector(uuid, uuid, boolean, text)','EXECUTE'),
    'acl_authenticated', has_function_privilege('authenticated','public.set_andrel_connector(uuid, uuid, boolean, text)','EXECUTE'),
    'acl_service_role', has_function_privilege('service_role','public.set_andrel_connector(uuid, uuid, boolean, text)','EXECUTE'),
    'already_notifies', EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)')
                                 AND prosrc LIKE '%INSERT INTO public.notifications%')),
  'notifications_surface', jsonb_build_object(
    'table_present', to_regclass('public.notifications') IS NOT NULL,
    'columns', (SELECT coalesce(jsonb_agg(column_name ORDER BY ordinal_position), '[]'::jsonb)
                  FROM information_schema.columns WHERE table_schema='public' AND table_name='notifications'),
    'required_columns_present', NOT EXISTS (
        SELECT 1 FROM unnest(ARRAY['user_id','type','title','body','link','data','created_at']) c
         WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_schema='public' AND table_name='notifications' AND column_name = c)),
    -- The exact-once guarantee IS this index (migration 006). Without it ON CONFLICT DO NOTHING
    -- degrades into "insert every time", so 083 refuses when it is missing.
    'dedupe_unique_index_present', EXISTS (SELECT 1 FROM pg_indexes
        WHERE schemaname='public' AND indexname='notifications_user_type_dedupe_key_uniq'),
    'rls_enabled', (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.notifications')),
    'policies', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', policyname, 'cmd', cmd, 'roles', roles) ORDER BY policyname), '[]'::jsonb)
                   FROM pg_policies WHERE schemaname='public' AND tablename='notifications'),
    -- REPORTED, NOT ASSERTED. 083 changes no grant here. If a browser role holds INSERT or DELETE
    -- that is a pre-existing posture to review on its own terms, not something this migration fixes.
    'owner', (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = to_regclass('public.notifications')),
    'rls_forced', (SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass('public.notifications')),
    'raw_acl', (SELECT coalesce(array_to_string(relacl::text[], ','), '(NONE)') FROM pg_class WHERE oid = to_regclass('public.notifications')),
    'policies_full', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'name', policyname, 'cmd', cmd, 'permissive', permissive, 'roles', roles,
        'using', qual, 'with_check', with_check) ORDER BY policyname), '[]'::jsonb)
      FROM pg_policies WHERE schemaname='public' AND tablename='notifications'),
    'grants', (SELECT jsonb_object_agg(g.role, jsonb_build_object(
        'select', has_table_privilege(g.role,'public.notifications','SELECT'),
        'insert', has_table_privilege(g.role,'public.notifications','INSERT'),
        'update', has_table_privilege(g.role,'public.notifications','UPDATE'),
        'delete', has_table_privilege(g.role,'public.notifications','DELETE'),
        'truncate', has_table_privilege(g.role,'public.notifications','TRUNCATE')))
      FROM unnest(ARRAY['anon','authenticated','service_role']) g(role)),
    'public_grant_present', EXISTS (SELECT 1 FROM pg_class c, unnest(coalesce(c.relacl, ARRAY[]::aclitem[])) a
                                     WHERE c.oid = to_regclass('public.notifications') AND a::text LIKE '=%'),
    -- Column-level UPDATE. read_at is the ONLY column a member legitimately writes.
    'authenticated_column_update', (SELECT jsonb_object_agg(c.column_name,
          has_column_privilege('authenticated','public.notifications', c.column_name,'UPDATE'))
      FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name='notifications'),
    'triggers_on_notifications', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'name', tgname, 'definition', pg_get_triggerdef(oid)) ORDER BY tgname), '[]'::jsonb)
      FROM pg_trigger WHERE tgrelid = to_regclass('public.notifications') AND NOT tgisinternal),
    'dedupe_index_definition', (SELECT indexdef FROM pg_indexes
      WHERE schemaname='public' AND indexname='notifications_user_type_dedupe_key_uniq'),
    'browser_callable_definers_inserting_notifications', (SELECT coalesce(jsonb_agg(p.proname ORDER BY p.proname), '[]'::jsonb)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.prosecdef AND p.prosrc LIKE '%INSERT INTO public.notifications%'
        AND (has_function_privilege('anon', p.oid,'EXECUTE') OR has_function_privilege('authenticated', p.oid,'EXECUTE')
             OR EXISTS (SELECT 1 FROM unnest(coalesce(p.proacl, ARRAY[]::aclitem[])) a WHERE a::text LIKE '=%'))),
    'existing_badge_notifications', (SELECT count(*) FROM public.notifications WHERE type = 'andrel_connector_awarded')),
  'recognition', jsonb_build_object(
    'ledger_present', to_regclass('public.member_recognition_events') IS NOT NULL,
    'members_badged', (SELECT count(*) FROM public.profiles WHERE is_andrel_connector),
    'audit_events', (SELECT count(*) FROM public.member_recognition_events),
    'note', 'existing_badge_notifications and audit_events are expected to be 0 before AND after '
            'apply: 083 backfills nothing and notifies nobody during apply.')
)) AS preflight_083;
