-- 080 POST-APPLY — read-only. ONE top-level SELECT, one JSONB envelope. Run AFTER applying 080.
-- Anything not PASS must be investigated before CAPACITY_RELEASE_MODE is moved off 'off'.
-- No DML, DDL, transaction control, row locks, SELECT INTO, or side-effect-capable calls.
--
-- Every function is resolved by EXACT SIGNATURE via to_regprocedure(), never by proname. Exactly one
-- signature must exist per name: an accidental overload means a caller can reach a body nothing
-- audited, so it is a BLOCKER here rather than a note.
--
-- expire_intro_pair is checked byte-for-byte at the function-body level. 080 must not have touched
-- it; if its md5 moved, the 14-day delayed-mutual behaviour changed as collateral damage.
WITH expected(fname, sig, ident_args, result_type, must_be_release_aware, pinned_md5, pinned_chars) AS (
  VALUES
    ('create_reciprocal_suggestion',
     'public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer)',
     'a_id uuid, b_id uuid, p_source text, p_reason text, p_cooldown_days integer, p_max_cards integer',
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
    ('express_intro_interest',
     'public.express_intro_interest(uuid, uuid, uuid, text)',
     'p_suggested_id uuid, p_requester_id uuid, p_target_user_id uuid, p_note text',
     'TABLE(out_state text, out_detail text, out_intro_request_id uuid)', false, NULL, NULL),
    ('release_intro_capacity',
     'public.release_intro_capacity(uuid, integer)',
     'p_intro_request_id uuid, p_min_wait_hours integer',
     'boolean', false, NULL, NULL),
    -- UNCHANGED BY 080 — pinned to the pre-apply production body.
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
         md5(p.prosrc) AS got_md5, length(p.prosrc) AS got_chars, octet_length(p.prosrc) AS got_octets,
         coalesce(array_to_string(p.proconfig, ','), '(NONE)') AS got_config,
         EXISTS (SELECT 1 FROM unnest(coalesce(p.proacl, ARRAY[]::aclitem[])) a
                  WHERE a::text LIKE '=%') AS acl_public,
         has_function_privilege('anon',          r.fn_oid, 'EXECUTE') AS acl_anon,
         has_function_privilege('authenticated', r.fn_oid, 'EXECUTE') AS acl_authenticated,
         has_function_privilege('service_role',  r.fn_oid, 'EXECUTE') AS acl_service_role,
         p.prosrc LIKE '%capacity_released_at IS NULL%' AS release_aware,
         p.prosrc LIKE '%pg_advisory_xact_lock%'        AS takes_advisory_lock
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
    CASE WHEN d.must_be_release_aware AND NOT d.release_aware THEN 'WRITER_NOT_RELEASE_AWARE' END,
    CASE WHEN d.pinned_md5   IS NOT NULL AND d.got_md5   IS DISTINCT FROM d.pinned_md5   THEN 'PINNED_BODY_MD5_CHANGED' END,
    CASE WHEN d.pinned_chars IS NOT NULL AND d.got_chars IS DISTINCT FROM d.pinned_chars THEN 'PINNED_BODY_LENGTH_CHANGED' END
  ], NULL) AS blockers
  FROM detail d
),
populations AS (
  SELECT
    (SELECT count(*) FROM public.intro_requests WHERE responds_to_id IS NOT NULL) AS rows_with_responds_to_id,
    (SELECT count(*) FROM public.intro_requests WHERE capacity_released_at IS NOT NULL) AS rows_released,
    (SELECT count(*) FROM public.intro_requests
      WHERE responds_to_id IS NOT NULL AND pair_id IS NOT NULL) AS expressions_carrying_pair_id_defect,
    (SELECT count(*) FROM public.intro_requests ir
      WHERE ir.responds_to_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.intro_requests c WHERE c.id = ir.responds_to_id)) AS orphaned_correlations,
    (SELECT count(*) FROM public.intro_requests
      WHERE capacity_released_at IS NOT NULL AND pair_id IS NULL) AS released_but_unpaired_defect,
    (SELECT count(*) FROM public.intro_requests t
      WHERE t.capacity_released_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.intro_requests e WHERE e.responds_to_id = t.id)) AS released_with_no_correlated_expression_defect,
    (SELECT count(*) FROM (SELECT ir.requester_id FROM public.intro_requests ir
       WHERE ir.status='suggested' AND ir.capacity_released_at IS NULL
       GROUP BY 1 HAVING count(*) > 2) d) AS members_above_visible_cap_defect,
    (SELECT count(*) FROM public.intro_requests
      WHERE capacity_released_at IS NOT NULL AND status <> 'suggested') AS released_cards_no_longer_suggested,
    (SELECT count(*) FROM public.introduction_capacity_review) AS operator_review_rows
)
SELECT jsonb_pretty(jsonb_build_object(
  'audit', '080_postapply', 'generated_at', now(),
  'overall_verdict', CASE WHEN EXISTS (SELECT 1 FROM judged WHERE cardinality(blockers) > 0)
                   OR (SELECT rows_with_responds_to_id + rows_released
                            + expressions_carrying_pair_id_defect + orphaned_correlations
                            + released_but_unpaired_defect + released_with_no_correlated_expression_defect
                            + members_above_visible_cap_defect FROM populations) <> 0
                  THEN 'BLOCKER' ELSE 'PASS' END,
  'schema', jsonb_build_object(
    'responds_to_id_present', EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name='intro_requests' AND column_name='responds_to_id'),
    'capacity_released_at_present', EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name='intro_requests' AND column_name='capacity_released_at'),
    'no_fk_on_responds_to_id', NOT EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid=to_regclass('public.intro_requests') AND contype='f'::"char"
          AND pg_get_constraintdef(oid) LIKE '%responds_to_id%'),
    'released_requires_pair_check', EXISTS (SELECT 1 FROM pg_constraint
        WHERE conname='intro_requests_released_requires_pair_chk'),
    'check_does_NOT_pin_status', NOT EXISTS (SELECT 1 FROM pg_constraint
        WHERE conname='intro_requests_released_requires_pair_chk'
          AND pg_get_constraintdef(oid) LIKE '%suggested%'),
    'one_expression_per_card_index', EXISTS (SELECT 1 FROM pg_indexes
        WHERE indexname='intro_requests_one_expression_per_card_uniq'),
    'capacity_live_index', EXISTS (SELECT 1 FROM pg_indexes
        WHERE indexname='intro_requests_capacity_live_idx'),
    'responds_to_index', EXISTS (SELECT 1 FROM pg_indexes
        WHERE indexname='intro_requests_responds_to_idx'),
    'review_view_service_role_only', NOT has_table_privilege('authenticated','public.introduction_capacity_review','SELECT')
                                 AND NOT has_table_privilege('anon','public.introduction_capacity_review','SELECT')
                                 AND has_table_privilege('service_role','public.introduction_capacity_review','SELECT')),
  'no_accidental_overloads', NOT EXISTS (SELECT 1 FROM judged WHERE signatures_deployed <> 1),
  'functions', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'name', j.fname,
             'resolved_oid', j.fn_oid::text,
             'signature_expected', j.sig,
             'signatures_deployed_for_name', j.signatures_deployed,
             'identity_args_expected', j.ident_args,
             'identity_args_deployed', j.got_ident_args,
             'result_type_expected', j.result_type,
             'result_type_deployed', j.got_result_type,
             'body_md5', j.got_md5, 'body_chars', j.got_chars, 'body_octets', j.got_octets,
             'pinned_body_md5', j.pinned_md5, 'pinned_body_chars', j.pinned_chars,
             'security_definer', j.prosecdef, 'config', j.got_config,
             'takes_advisory_lock', j.takes_advisory_lock,
             'release_aware', j.release_aware, 'release_aware_required', j.must_be_release_aware,
             'acl_public', j.acl_public, 'acl_anon', j.acl_anon,
             'acl_authenticated', j.acl_authenticated, 'acl_service_role', j.acl_service_role,
             'verdict', CASE WHEN cardinality(j.blockers) = 0 THEN 'PASS' ELSE 'BLOCKER' END,
             'blockers', to_jsonb(j.blockers))
           ORDER BY j.fname)
    FROM judged j), '[]'::jsonb),
  'expire_intro_pair_unchanged', (SELECT jsonb_build_object(
      'expected_md5', j.pinned_md5, 'deployed_md5', j.got_md5,
      'expected_chars', j.pinned_chars, 'deployed_chars', j.got_chars,
      'unchanged', j.got_md5 IS NOT DISTINCT FROM j.pinned_md5
                   AND j.got_chars IS NOT DISTINCT FROM j.pinned_chars,
      'release_aware_MUST_be_false', j.release_aware)
    FROM judged j WHERE j.fname = 'expire_intro_pair'),
  'outbox', jsonb_build_object(
    'trigger_still_update_of_status', EXISTS (SELECT 1 FROM pg_trigger
        WHERE tgname='intro_requests_visible_outbox_aiu' AND NOT tgisinternal
          AND pg_get_triggerdef(oid) LIKE '%UPDATE OF status%'),
    'trigger_enabled', EXISTS (SELECT 1 FROM pg_trigger
        WHERE tgname='intro_requests_visible_outbox_aiu' AND NOT tgisinternal AND tgenabled <> 'D')),
  'runtime', (SELECT jsonb_build_object(
    'rows_with_responds_to_id', p.rows_with_responds_to_id,
    'rows_released', p.rows_released,
    'expressions_carrying_pair_id_DEFECT', p.expressions_carrying_pair_id_defect,
    'orphaned_correlations', p.orphaned_correlations,
    'released_but_unpaired_DEFECT', p.released_but_unpaired_defect,
    'released_with_no_correlated_expression_DEFECT', p.released_with_no_correlated_expression_defect,
    'members_above_visible_cap_DEFECT', p.members_above_visible_cap_defect,
    'released_cards_no_longer_suggested', p.released_cards_no_longer_suggested,
    'operator_review_rows', p.operator_review_rows,
    'note', 'immediately after apply every value above except operator_review_rows must be 0; '
            'nothing is backfilled and no card moves until the worker runs with mode on')
    FROM populations p)
)) AS postapply_080;
