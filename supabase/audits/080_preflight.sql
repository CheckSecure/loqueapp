-- 080 PREFLIGHT — read-only. ONE top-level SELECT, one JSONB envelope. Run BEFORE applying 080.
-- No DML, DDL, transaction control, row locks, SELECT INTO, or side-effect-capable calls.
-- Emits no member identity: ids, counts and catalog metadata only.
--
-- Every protected function is resolved by EXACT SIGNATURE via to_regprocedure() — never by proname,
-- never with LIMIT 1 — and reported against its explicit expected value, so the operator compares
-- rather than infers. An unexpected overload is a BLOCKER, not a note.
--
-- body_chars is length(prosrc), which counts CHARACTERS. body_octets is octet_length(prosrc). These
-- bodies contain multi-byte characters in their comments, so the two legitimately differ (by 178 for
-- materialize_admin_pair). The drift guard inside 080 pins body_chars; both are emitted here so the
-- distinction can never be misread as drift again.
WITH expected(fname, sig, ident_args, result_type, want_md5, want_chars, replaced_by_080) AS (
  VALUES
    ('create_reciprocal_suggestion',
     'public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer)',
     'a_id uuid, b_id uuid, p_source text, p_reason text, p_cooldown_days integer, p_max_cards integer',
     'text', '8d62f30d84f079c1dcc4aa22848dba9d', 6103, true),
    ('place_batch_rows',
     'public.place_batch_rows(uuid, text, jsonb, uuid, integer)',
     'p_member_id uuid, p_source text, p_rows jsonb, p_reciprocal_batch_id uuid, p_cooldown_days integer',
     'jsonb', '2eca64f2e35735feb6ca45212488885d', 11413, true),
    ('promote_queued_rows',
     'public.promote_queued_rows(uuid)',
     'p_member_id uuid',
     'jsonb', '690f0f6aead9a4831073e32af8d53e1f', 6090, true),
    ('materialize_admin_pair',
     'public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer)',
     'p_review_batch_id uuid, p_member_a uuid, p_member_b uuid, p_batch_a uuid, p_batch_b uuid, p_cooldown_days integer',
     'jsonb', 'd64aa2aa8627089cd82cbcbc586ddca1', 22015, true),
    ('expire_intro_pair',
     'public.expire_intro_pair(uuid, integer)',
     'p_pair_id uuid, p_max_age_days integer',
     'jsonb', 'c786da9312cf962eb06ec6463ceecfd8', 5146, false)
),
resolved AS (
  SELECT e.*, to_regprocedure(e.sig) AS fn_oid,
         (SELECT count(*) FROM pg_catalog.pg_proc p
            JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = e.fname) AS signatures_deployed
  FROM expected e
),
detail AS (
  SELECT r.*,
         p.prosrc, p.prosecdef, p.proacl,
         pg_get_function_identity_arguments(r.fn_oid) AS got_ident_args,
         pg_get_function_result(r.fn_oid)             AS got_result_type,
         md5(p.prosrc)                                AS got_md5,
         length(p.prosrc)                             AS got_chars,
         octet_length(p.prosrc)                       AS got_octets,
         coalesce(array_to_string(p.proconfig, ','), '(NONE)') AS got_config,
         EXISTS (SELECT 1 FROM unnest(coalesce(p.proacl, ARRAY[]::aclitem[])) a
                  WHERE a::text LIKE '=%')            AS acl_public,
         has_function_privilege('anon',          r.fn_oid, 'EXECUTE') AS acl_anon,
         has_function_privilege('authenticated', r.fn_oid, 'EXECUTE') AS acl_authenticated,
         has_function_privilege('service_role',  r.fn_oid, 'EXECUTE') AS acl_service_role
  FROM resolved r LEFT JOIN pg_catalog.pg_proc p ON p.oid = r.fn_oid
),
judged AS (
  SELECT d.*,
         ARRAY_REMOVE(ARRAY[
           CASE WHEN d.fn_oid IS NULL              THEN 'SIGNATURE_ABSENT' END,
           CASE WHEN d.signatures_deployed <> 1    THEN 'UNEXPECTED_OVERLOAD' END,
           CASE WHEN d.got_ident_args IS DISTINCT FROM d.ident_args  THEN 'IDENTITY_ARGS_DIFFER' END,
           CASE WHEN d.got_result_type IS DISTINCT FROM d.result_type THEN 'RESULT_TYPE_DIFFERS' END,
           CASE WHEN d.got_md5   IS DISTINCT FROM d.want_md5   THEN 'BODY_MD5_DIFFERS' END,
           CASE WHEN d.got_chars IS DISTINCT FROM d.want_chars THEN 'BODY_LENGTH_DIFFERS' END,
           CASE WHEN d.prosecdef IS DISTINCT FROM true THEN 'NOT_SECURITY_DEFINER' END,
           CASE WHEN d.got_config NOT IN ('search_path=', 'search_path=""') THEN 'SEARCH_PATH_NOT_EMPTY' END,
           CASE WHEN d.acl_public        THEN 'EXECUTABLE_BY_PUBLIC' END,
           CASE WHEN d.acl_anon          THEN 'EXECUTABLE_BY_ANON' END,
           CASE WHEN d.acl_authenticated THEN 'EXECUTABLE_BY_AUTHENTICATED' END,
           CASE WHEN NOT d.acl_service_role THEN 'SERVICE_ROLE_CANNOT_EXECUTE' END,
           CASE WHEN d.prosrc LIKE '%capacity_released_at%' THEN 'ALREADY_RELEASE_AWARE' END
         ], NULL) AS blockers
  FROM detail d
)
SELECT jsonb_pretty(jsonb_build_object(
  'audit', '080_preflight', 'generated_at', now(),
  'overall_verdict', CASE WHEN EXISTS (SELECT 1 FROM judged WHERE cardinality(blockers) > 0)
                  THEN 'BLOCKER' ELSE 'PASS' END,
  'blocker_count', (SELECT coalesce(sum(cardinality(blockers)), 0) FROM judged),
  'environment', jsonb_build_object(
    'intro_requests_present', to_regclass('public.intro_requests') IS NOT NULL,
    'member_pairs_present',   to_regclass('public.member_pairs')   IS NOT NULL,
    'outbox_trigger_present', EXISTS (SELECT 1 FROM pg_trigger
        WHERE tgname='intro_requests_visible_outbox_aiu' AND NOT tgisinternal),
    'roles_present', (SELECT jsonb_object_agg(rn, EXISTS (SELECT 1 FROM pg_roles WHERE rolname = rn))
                      FROM unnest(ARRAY['anon','authenticated','service_role']) rn),
    'columns_already_added', EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name='intro_requests' AND column_name='capacity_released_at')),
  'protected_functions', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'name', j.fname,
             'replaced_by_080', j.replaced_by_080,
             'resolved_oid', j.fn_oid::text,
             'signature_expected', j.sig,
             'signatures_deployed_for_name', j.signatures_deployed,
             'identity_args_expected', j.ident_args,
             'identity_args_deployed', j.got_ident_args,
             'result_type_expected', j.result_type,
             'result_type_deployed', j.got_result_type,
             'body_md5_expected', j.want_md5,
             'body_md5_deployed', j.got_md5,
             'body_chars_expected', j.want_chars,
             'body_chars_deployed', j.got_chars,
             'body_octets_deployed', j.got_octets,
             'security_definer', j.prosecdef,
             'config', j.got_config,
             'acl_public', j.acl_public,
             'acl_anon', j.acl_anon,
             'acl_authenticated', j.acl_authenticated,
             'acl_service_role', j.acl_service_role,
             'already_release_aware', j.prosrc LIKE '%capacity_released_at%',
             'verdict', CASE WHEN cardinality(j.blockers) = 0 THEN 'PASS' ELSE 'BLOCKER' END,
             'blockers', to_jsonb(j.blockers))
           ORDER BY j.fname)
    FROM judged j), '[]'::jsonb),
  -- Populations 080 must NOT sweep up. Reported so the numbers are known before, not after.
  'populations', jsonb_build_object(
    'hidden_waiting_rows_total', (SELECT count(*) FROM public.intro_requests s
        WHERE s.status='suggested' AND EXISTS (SELECT 1 FROM public.intro_requests e
          WHERE e.requester_id=s.requester_id AND e.target_user_id=s.target_user_id
            AND e.status IN ('pending','approved','accepted','accepted_pending_payment','admin_pending'))),
    'hidden_waiting_WITHOUT_pair_id', (SELECT count(*) FROM public.intro_requests s
        WHERE s.status='suggested' AND s.pair_id IS NULL
          AND EXISTS (SELECT 1 FROM public.intro_requests e
            WHERE e.requester_id=s.requester_id AND e.target_user_id=s.target_user_id
              AND e.status IN ('pending','approved','accepted','accepted_pending_payment','admin_pending'))),
    'open_cards_with_ineligible_owner', (SELECT count(*) FROM public.intro_requests ir
        JOIN public.profiles p ON p.id=ir.requester_id
        WHERE ir.status='suggested'
          AND (p.account_status IS DISTINCT FROM 'active' OR p.profile_complete IS DISTINCT FROM true)),
    'rows_that_would_release_immediately', 0,
    'note', 'rows_that_would_release_immediately is 0 BY CONSTRUCTION: release requires responds_to_id, '
            'which is NULL on every existing row and is never backfilled. No card can move on apply. '
            'The hidden-waiting, pairless and ineligible-owner rows above are reported, never mutated.')
)) AS preflight_080;
