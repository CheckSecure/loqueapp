-- 081 PREFLIGHT — read-only. ONE top-level SELECT, one JSONB envelope. Run BEFORE applying 081.
-- No DML, DDL, transaction control, row locks, SELECT INTO, or side-effect-capable calls.
--
-- Every protected function is resolved by EXACT SIGNATURE via to_regprocedure(). The expected bodies
-- are the POST-080 bodies — what migration 080 installed — so this confirms the deployed state is
-- the one 081's drift guard is written against before anything is replaced.
--
-- body_chars is length(prosrc) (CHARACTERS); body_octets is octet_length(prosrc). These bodies
-- contain multi-byte characters, so the two legitimately differ. The guard pins body_chars.
WITH expected(fname, sig, ident_args, result_type, want_md5, want_chars, replaced_by_081) AS (
  VALUES
    ('create_reciprocal_suggestion',
     'public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer)',
     'a_id uuid, b_id uuid, p_source text, p_reason text, p_cooldown_days integer, p_max_cards integer',
     'text',  'e86e1dde486a4da9c72883b42e0fb391', 6187,  true),
    ('place_batch_rows',
     'public.place_batch_rows(uuid, text, jsonb, uuid, integer)',
     'p_member_id uuid, p_source text, p_rows jsonb, p_reciprocal_batch_id uuid, p_cooldown_days integer',
     'jsonb', '64512aa7d77c56a251239cf329527b1b', 11449, true),
    ('promote_queued_rows',
     'public.promote_queued_rows(uuid)',
     'p_member_id uuid',
     'jsonb', 'bf31f1ce0df71c432e098e7e1b6311dd', 6132,  true),
    ('materialize_admin_pair',
     'public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer)',
     'p_review_batch_id uuid, p_member_a uuid, p_member_b uuid, p_batch_a uuid, p_batch_b uuid, p_cooldown_days integer',
     'jsonb', 'a2f2fbd5e3c5c63993b2a59849fe7c6b', 22087, true),
    ('expire_intro_pair',
     'public.expire_intro_pair(uuid, integer)',
     'p_pair_id uuid, p_max_age_days integer',
     'jsonb', 'c786da9312cf962eb06ec6463ceecfd8', 5146,  false)
),
resolved AS (
  SELECT e.*, to_regprocedure(e.sig) AS fn_oid,
         (SELECT count(*) FROM pg_catalog.pg_proc p
            JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = e.fname) AS signatures_deployed
  FROM expected e
),
detail AS (
  SELECT r.*, p.prosrc, p.prosecdef,
         pg_get_function_identity_arguments(r.fn_oid) AS got_ident_args,
         pg_get_function_result(r.fn_oid)             AS got_result_type,
         md5(p.prosrc) AS got_md5, length(p.prosrc) AS got_chars, octet_length(p.prosrc) AS got_octets,
         coalesce(array_to_string(p.proconfig, ','), '(NONE)') AS got_config,
         EXISTS (SELECT 1 FROM unnest(coalesce(p.proacl, ARRAY[]::aclitem[])) a
                  WHERE a::text LIKE '=%') AS acl_public,
         has_function_privilege('anon',          r.fn_oid, 'EXECUTE') AS acl_anon,
         has_function_privilege('authenticated', r.fn_oid, 'EXECUTE') AS acl_authenticated,
         has_function_privilege('service_role',  r.fn_oid, 'EXECUTE') AS acl_service_role
  FROM resolved r LEFT JOIN pg_catalog.pg_proc p ON p.oid = r.fn_oid
),
judged AS (
  SELECT d.*, ARRAY_REMOVE(ARRAY[
    CASE WHEN d.fn_oid IS NULL           THEN 'SIGNATURE_ABSENT' END,
    CASE WHEN d.signatures_deployed <> 1 THEN 'UNEXPECTED_OVERLOAD' END,
    CASE WHEN d.got_ident_args  IS DISTINCT FROM d.ident_args  THEN 'IDENTITY_ARGS_DIFFER' END,
    CASE WHEN d.got_result_type IS DISTINCT FROM d.result_type THEN 'RESULT_TYPE_DIFFERS' END,
    CASE WHEN d.got_md5   IS DISTINCT FROM d.want_md5   THEN 'BODY_MD5_DIFFERS' END,
    CASE WHEN d.got_chars IS DISTINCT FROM d.want_chars THEN 'BODY_LENGTH_DIFFERS' END,
    CASE WHEN d.prosecdef IS DISTINCT FROM true THEN 'NOT_SECURITY_DEFINER' END,
    CASE WHEN d.got_config NOT IN ('search_path=', 'search_path=""') THEN 'SEARCH_PATH_NOT_EMPTY' END,
    CASE WHEN d.acl_public        THEN 'EXECUTABLE_BY_PUBLIC' END,
    CASE WHEN d.acl_anon          THEN 'EXECUTABLE_BY_ANON' END,
    CASE WHEN d.acl_authenticated THEN 'EXECUTABLE_BY_AUTHENTICATED' END,
    CASE WHEN NOT d.acl_service_role THEN 'SERVICE_ROLE_CANNOT_EXECUTE' END,
    CASE WHEN d.prosrc LIKE '%count_unresolved_introductions%' THEN 'ALREADY_GATED_081_APPLIED' END
  ], NULL) AS blockers
  FROM detail d
)
SELECT jsonb_pretty(jsonb_build_object(
  'audit', '081_preflight', 'generated_at', now(),
  'overall_verdict', CASE
      WHEN EXISTS (SELECT 1 FROM judged WHERE cardinality(blockers) > 0) THEN 'BLOCKER'
      WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name='intro_requests' AND column_name='capacity_released_at') THEN 'BLOCKER'
      ELSE 'PASS' END,
  'blocker_count', (SELECT coalesce(sum(cardinality(blockers)), 0) FROM judged),
  'prerequisites', jsonb_build_object(
    'migration_080_applied', EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name='intro_requests' AND column_name='capacity_released_at'),
    'express_intro_interest_present', to_regprocedure('public.express_intro_interest(uuid, uuid, uuid, text)') IS NOT NULL,
    'release_id_already_added', EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name='intro_requests' AND column_name='release_id'),
    'predicate_already_present', to_regprocedure('public.count_unresolved_introductions(uuid, uuid, uuid)') IS NOT NULL,
    'roles_present', (SELECT jsonb_object_agg(rn, EXISTS (SELECT 1 FROM pg_roles WHERE rolname = rn))
                      FROM unnest(ARRAY['anon','authenticated','service_role']) rn)),
  'protected_functions', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'name', j.fname, 'replaced_by_081', j.replaced_by_081,
             'resolved_oid', j.fn_oid::text,
             'signature_expected', j.sig,
             'signatures_deployed_for_name', j.signatures_deployed,
             'identity_args_expected', j.ident_args, 'identity_args_deployed', j.got_ident_args,
             'result_type_expected', j.result_type, 'result_type_deployed', j.got_result_type,
             'body_md5_expected', j.want_md5,   'body_md5_deployed', j.got_md5,
             'body_chars_expected', j.want_chars, 'body_chars_deployed', j.got_chars,
             'body_octets_deployed', j.got_octets,
             'security_definer', j.prosecdef, 'config', j.got_config,
             'acl_public', j.acl_public, 'acl_anon', j.acl_anon,
             'acl_authenticated', j.acl_authenticated, 'acl_service_role', j.acl_service_role,
             'verdict', CASE WHEN cardinality(j.blockers) = 0 THEN 'PASS' ELSE 'BLOCKER' END,
             'blockers', to_jsonb(j.blockers))
           ORDER BY j.fname)
    FROM judged j), '[]'::jsonb),
  -- What the rule will apply to on day one. Reported, never mutated.
  'populations', jsonb_build_object(
    'members_with_an_unanswered_card', (SELECT count(DISTINCT s.requester_id)
      FROM public.intro_requests s JOIN public.profiles t ON t.id = s.target_user_id
      WHERE s.status='suggested' AND t.account_status='active'
        AND NOT EXISTS (SELECT 1 FROM public.intro_requests e
              WHERE e.requester_id=s.requester_id AND e.target_user_id=s.target_user_id
                AND e.status IN ('pending','approved','accepted','accepted_pending_payment','admin_pending'))
        AND NOT EXISTS (SELECT 1 FROM public.intro_requests inb
              WHERE inb.requester_id=s.target_user_id AND inb.target_user_id=s.requester_id
                AND inb.status IN ('pending','approved','accepted','accepted_pending_payment','admin_pending'))
        AND NOT EXISTS (SELECT 1 FROM public.matches m
              WHERE (m.user_a_id=s.requester_id AND m.user_b_id=s.target_user_id)
                 OR (m.user_a_id=s.target_user_id AND m.user_b_id=s.requester_id))),
    'suggested_rows_with_inactive_target', (SELECT count(*)
      FROM public.intro_requests s JOIN public.profiles t ON t.id = s.target_user_id
      WHERE s.status='suggested' AND t.account_status IS DISTINCT FROM 'active'),
    -- COUNTED WITHOUT NAMING THE COLUMN.
    --
    -- This audit must PARSE and run BEFORE 081 exists. PostgreSQL resolves every column reference
    -- while parsing the statement, so `WHERE release_id IS NOT NULL` raises 42703 on a pre-081
    -- database no matter what CASE or JSON expression wraps it — a guard cannot protect a reference
    -- the parser has already rejected. That is exactly how this failed in production.
    --
    -- to_jsonb(t) names only the TABLE. The key lookup is a runtime string, so the statement parses
    -- identically in both states: before 081 every row lacks the key and yields NULL, after 081 the
    -- value is read exactly. It is an exact count, not an estimate — pg_stats would have been
    -- neither exact nor available for a column that has never been analyzed.
    --
    -- The catalog EXISTS is a PERFORMANCE guard only, never a correctness one: both arms parse, and
    -- CASE evaluates only the arm it takes, so a pre-081 database does no table scan at all.
    'rows_with_release_id', CASE
        WHEN EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema='public' AND table_name='intro_requests' AND column_name='release_id')
        THEN (SELECT count(*) FROM public.intro_requests t WHERE to_jsonb(t) ->> 'release_id' IS NOT NULL)
        ELSE 0 END,
    'note', 'rows_with_release_id must be 0 before AND immediately after apply: release_id is never '
            'backfilled. Members with an unanswered card are not mutated - they simply become '
            'ineligible for a LATER release until they respond.')
)) AS preflight_081;
