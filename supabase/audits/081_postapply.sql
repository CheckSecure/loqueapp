-- 081 POST-APPLY — read-only. ONE top-level SELECT, one JSONB envelope. Run AFTER applying 081.
-- No DML, DDL, transaction control, row locks, SELECT INTO, or side-effect-capable calls.
--
-- Proves the gate is installed in every writer, that the reciprocal writer was REPLACED rather than
-- joined by an overload (its signature changed, so the old one must be gone), that the predicate is
-- service_role-only, that expire_intro_pair is still byte-identical, and that nothing was backfilled.
WITH expected(fname, sig, ident_args, result_type, must_be_gated, pinned_md5, pinned_chars) AS (
  VALUES
    ('create_reciprocal_suggestion',
     'public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer, uuid)',
     'a_id uuid, b_id uuid, p_source text, p_reason text, p_cooldown_days integer, p_max_cards integer, p_release_id uuid',
     'text',  true,  NULL::text, NULL::integer),
    ('place_batch_rows',
     'public.place_batch_rows(uuid, text, jsonb, uuid, integer)',
     'p_member_id uuid, p_source text, p_rows jsonb, p_reciprocal_batch_id uuid, p_cooldown_days integer',
     'jsonb', true,  NULL, NULL),
    ('promote_queued_rows',
     'public.promote_queued_rows(uuid)',
     'p_member_id uuid',
     'jsonb', true,  NULL, NULL),
    ('materialize_admin_pair',
     'public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer)',
     'p_review_batch_id uuid, p_member_a uuid, p_member_b uuid, p_batch_a uuid, p_batch_b uuid, p_cooldown_days integer',
     'jsonb', true,  NULL, NULL),
    ('count_unresolved_introductions',
     'public.count_unresolved_introductions(uuid, uuid, uuid)',
     'p_member_id uuid, p_exclude_release uuid, p_exclude_batch uuid',
     'integer', false, NULL, NULL),
    ('express_intro_interest',
     'public.express_intro_interest(uuid, uuid, uuid, text)',
     'p_suggested_id uuid, p_requester_id uuid, p_target_user_id uuid, p_note text',
     'TABLE(out_state text, out_detail text, out_intro_request_id uuid)', false, NULL, NULL),
    ('release_intro_capacity',
     'public.release_intro_capacity(uuid, integer)',
     'p_intro_request_id uuid, p_min_wait_hours integer',
     'boolean', false, NULL, NULL),
    -- UNCHANGED BY 081 — pinned to the body 080 left in place.
    ('expire_intro_pair',
     'public.expire_intro_pair(uuid, integer)',
     'p_pair_id uuid, p_max_age_days integer',
     'jsonb', false, 'c786da9312cf962eb06ec6463ceecfd8', 5146)
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
         md5(p.prosrc) AS got_md5, length(p.prosrc) AS got_chars,
         coalesce(array_to_string(p.proconfig, ','), '(NONE)') AS got_config,
         EXISTS (SELECT 1 FROM unnest(coalesce(p.proacl, ARRAY[]::aclitem[])) a
                  WHERE a::text LIKE '=%') AS acl_public,
         has_function_privilege('anon',          r.fn_oid, 'EXECUTE') AS acl_anon,
         has_function_privilege('authenticated', r.fn_oid, 'EXECUTE') AS acl_authenticated,
         has_function_privilege('service_role',  r.fn_oid, 'EXECUTE') AS acl_service_role,
         p.prosrc LIKE '%count_unresolved_introductions%' AS gated,
         p.prosrc LIKE '%pg_advisory_xact_lock%'          AS takes_advisory_lock
  FROM resolved r LEFT JOIN pg_catalog.pg_proc p ON p.oid = r.fn_oid
),
judged AS (
  SELECT d.*, ARRAY_REMOVE(ARRAY[
    CASE WHEN d.fn_oid IS NULL           THEN 'SIGNATURE_ABSENT' END,
    CASE WHEN d.signatures_deployed <> 1 THEN 'UNEXPECTED_OVERLOAD' END,
    CASE WHEN d.got_ident_args  IS DISTINCT FROM d.ident_args  THEN 'IDENTITY_ARGS_DIFFER' END,
    CASE WHEN d.got_result_type IS DISTINCT FROM d.result_type THEN 'RESULT_TYPE_DIFFERS' END,
    CASE WHEN d.prosecdef IS DISTINCT FROM true THEN 'NOT_SECURITY_DEFINER' END,
    CASE WHEN d.got_config NOT IN ('search_path=', 'search_path=""') THEN 'SEARCH_PATH_NOT_EMPTY' END,
    CASE WHEN d.acl_public        THEN 'EXECUTABLE_BY_PUBLIC' END,
    CASE WHEN d.acl_anon          THEN 'EXECUTABLE_BY_ANON' END,
    CASE WHEN d.acl_authenticated THEN 'EXECUTABLE_BY_AUTHENTICATED' END,
    CASE WHEN NOT d.acl_service_role THEN 'SERVICE_ROLE_CANNOT_EXECUTE' END,
    CASE WHEN d.must_be_gated AND NOT d.gated THEN 'WRITER_NOT_GATED' END,
    CASE WHEN d.pinned_md5   IS NOT NULL AND d.got_md5   IS DISTINCT FROM d.pinned_md5   THEN 'PINNED_BODY_MD5_CHANGED' END,
    CASE WHEN d.pinned_chars IS NOT NULL AND d.got_chars IS DISTINCT FROM d.pinned_chars THEN 'PINNED_BODY_LENGTH_CHANGED' END
  ], NULL) AS blockers
  FROM detail d
),
populations AS (
  SELECT
    (SELECT count(*) FROM public.intro_requests WHERE release_id IS NOT NULL) AS rows_with_release_id,
    (SELECT count(*) FROM public.intro_requests WHERE responds_to_id IS NOT NULL AND pair_id IS NOT NULL) AS expressions_carrying_pair_id_defect,
    (SELECT count(*) FROM public.intro_requests ir WHERE ir.responds_to_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.intro_requests c WHERE c.id = ir.responds_to_id)) AS orphaned_correlations,
    (SELECT count(*) FROM (SELECT ir.requester_id FROM public.intro_requests ir
       WHERE ir.status='suggested' AND ir.capacity_released_at IS NULL
       GROUP BY 1 HAVING count(*) > 2) d) AS members_above_visible_cap_defect,
    -- A card carrying an envelope that belongs to somebody else would mean release_id was borrowed
    -- across members. Zero by construction: only the release owner's row is ever stamped.
    (SELECT count(*) FROM (
       SELECT release_id FROM public.intro_requests WHERE release_id IS NOT NULL
       GROUP BY release_id HAVING count(DISTINCT requester_id) > 1) x) AS releases_spanning_members_defect,
    (SELECT count(*) FROM (
       SELECT requester_id, release_id FROM public.intro_requests
       WHERE release_id IS NOT NULL AND status = 'suggested'
       GROUP BY 1,2 HAVING count(*) > 2) y) AS oversized_releases_defect
)
SELECT jsonb_pretty(jsonb_build_object(
  'audit', '081_postapply', 'generated_at', now(),
  'overall_verdict', CASE WHEN EXISTS (SELECT 1 FROM judged WHERE cardinality(blockers) > 0)
                           OR (SELECT rows_with_release_id + expressions_carrying_pair_id_defect
                                    + orphaned_correlations + members_above_visible_cap_defect
                                    + releases_spanning_members_defect + oversized_releases_defect
                               FROM populations) <> 0
                          THEN 'BLOCKER' ELSE 'PASS' END,
  'schema', jsonb_build_object(
    'release_id_present', EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name='intro_requests' AND column_name='release_id'),
    'release_id_nullable', EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name='intro_requests' AND column_name='release_id' AND is_nullable='YES'),
    'no_fk_on_release_id', NOT EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid=to_regclass('public.intro_requests') AND contype='f'::"char"
          AND pg_get_constraintdef(oid) LIKE '%release_id%'),
    'unresolved_index', EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='intro_requests_unresolved_idx'),
    'old_reciprocal_signature_gone', to_regprocedure('public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer)') IS NULL),
  'no_accidental_overloads', NOT EXISTS (SELECT 1 FROM judged WHERE signatures_deployed <> 1),
  'all_writers_gated', NOT EXISTS (SELECT 1 FROM judged WHERE must_be_gated AND NOT gated),
  'functions', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'name', j.fname, 'resolved_oid', j.fn_oid::text,
             'signature_expected', j.sig, 'signatures_deployed_for_name', j.signatures_deployed,
             'identity_args_expected', j.ident_args, 'identity_args_deployed', j.got_ident_args,
             'result_type_expected', j.result_type, 'result_type_deployed', j.got_result_type,
             'body_md5', j.got_md5, 'body_chars', j.got_chars,
             'pinned_body_md5', j.pinned_md5,
             'security_definer', j.prosecdef, 'config', j.got_config,
             'takes_advisory_lock', j.takes_advisory_lock,
             'gated', j.gated, 'gate_required', j.must_be_gated,
             'acl_public', j.acl_public, 'acl_anon', j.acl_anon,
             'acl_authenticated', j.acl_authenticated, 'acl_service_role', j.acl_service_role,
             'verdict', CASE WHEN cardinality(j.blockers) = 0 THEN 'PASS' ELSE 'BLOCKER' END,
             'blockers', to_jsonb(j.blockers))
           ORDER BY j.fname)
    FROM judged j), '[]'::jsonb),
  'expire_intro_pair_unchanged', (SELECT jsonb_build_object(
      'expected_md5', j.pinned_md5, 'deployed_md5', j.got_md5,
      'unchanged', j.got_md5 IS NOT DISTINCT FROM j.pinned_md5)
    FROM judged j WHERE j.fname = 'expire_intro_pair'),
  'runtime', (SELECT jsonb_build_object(
    'rows_with_release_id', p.rows_with_release_id,
    'expressions_carrying_pair_id_DEFECT', p.expressions_carrying_pair_id_defect,
    'orphaned_correlations', p.orphaned_correlations,
    'members_above_visible_cap_DEFECT', p.members_above_visible_cap_defect,
    'releases_spanning_members_DEFECT', p.releases_spanning_members_defect,
    'oversized_releases_DEFECT', p.oversized_releases_defect,
    'note', 'immediately after apply every value above must be 0. release_id is never backfilled; it '
            'appears only on cards placed by a generator run AFTER the new build is live.')
    FROM populations p)
)) AS postapply_081;
