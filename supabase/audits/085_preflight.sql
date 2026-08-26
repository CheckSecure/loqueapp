-- 085 PREFLIGHT — read-only. Run BEFORE applying 085. Creates nothing, writes nothing, locks nothing.
-- overall_verdict: READY | ALREADY_APPLIED | BLOCKER: <reason>
WITH pred AS (
  SELECT p.oid, p.prosrc, p.prosecdef,
         pg_catalog.md5(p.prosrc) AS body_md5,
         pg_catalog.length(p.prosrc) AS body_chars,
         pg_catalog.octet_length(p.prosrc) AS body_octets
  FROM pg_catalog.pg_proc p
  WHERE p.oid = pg_catalog.to_regprocedure('public.count_unresolved_introductions(uuid, uuid, uuid)')
),
writers AS (
  SELECT t.fname,
         pg_catalog.to_regprocedure(t.sig) IS NOT NULL AS deployed,
         (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname='public' AND p.proname=t.fname) AS signatures,
         EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname='public' AND p.proname=t.fname
                    AND pg_catalog.strpos(p.prosrc,'count_unresolved_introductions')>0) AS calls_predicate
  FROM (VALUES
    ('create_reciprocal_suggestion','public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer, uuid)'),
    ('place_batch_rows','public.place_batch_rows(uuid, text, jsonb, uuid, integer)'),
    ('promote_queued_rows','public.promote_queued_rows(uuid)'),
    ('materialize_admin_pair','public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer)')
  ) AS t(fname, sig)
),
deps AS (
  SELECT
    pg_catalog.to_regclass('public.blocked_users') IS NOT NULL AS blocked_users,
    (SELECT count(*) FROM pg_catalog.pg_attribute
      WHERE attrelid='public.profiles'::pg_catalog.regclass AND NOT attisdropped
        AND attname IN ('profile_complete','is_test_account','matching_paused','account_status')) AS profile_cols,
    EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
             WHERE conname='intro_requests_resolution_reason_check'
               AND conrelid='public.intro_requests'::pg_catalog.regclass) AS reason_check,
    (SELECT pg_catalog.pg_get_constraintdef(oid) FROM pg_catalog.pg_constraint
      WHERE conname='intro_requests_resolution_reason_check'
        AND conrelid='public.intro_requests'::pg_catalog.regclass) AS reason_check_def
),
impact AS (
  -- Sizing only, no identities: how many live cards the corrected predicate will stop counting.
  SELECT
    count(*) AS suggested_rows,
    count(*) FILTER (WHERE t.id IS NULL) AS target_missing,
    count(*) FILTER (WHERE t.id IS NOT NULL AND t.account_status <> 'active') AS target_inactive,
    count(*) FILTER (WHERE t.id IS NOT NULL AND t.account_status = 'active' AND t.profile_complete IS NOT TRUE) AS target_incomplete,
    count(*) FILTER (WHERE t.id IS NOT NULL AND t.is_test_account IS TRUE) AS target_test,
    count(*) FILTER (WHERE t.id IS NOT NULL AND t.matching_paused IS TRUE) AS target_paused,
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.blocked_users bu
                     WHERE (bu.user_id=s.requester_id AND bu.blocked_user_id=s.target_user_id)
                        OR (bu.user_id=s.target_user_id AND bu.blocked_user_id=s.requester_id))) AS blocked_either_way
  FROM public.intro_requests s
  LEFT JOIN public.profiles t ON t.id = s.target_user_id
  WHERE s.status = 'suggested'
)
SELECT jsonb_pretty(jsonb_build_object(
  'checked_at', now(),
  'predicate', jsonb_build_object(
    'deployed', (SELECT count(*) FROM pred) = 1,
    'body_md5', (SELECT body_md5 FROM pred),
    'body_chars', (SELECT body_chars FROM pred),
    'body_octets', (SELECT body_octets FROM pred),
    'security_definer', (SELECT prosecdef FROM pred),
    'expect_pre_085_md5', 'c834301b7374934c88e27e1005959f0a',
    'expect_pre_085_chars', 1129,
    'already_corrected', (SELECT pg_catalog.strpos(prosrc,'is_available_intro_target')>0 FROM pred)),
  'writers', (SELECT jsonb_agg(jsonb_build_object(
      'name', fname, 'deployed', deployed, 'signatures', signatures, 'calls_predicate', calls_predicate)
      ORDER BY fname) FROM writers),
  'dependencies', jsonb_build_object(
    'blocked_users_table', (SELECT blocked_users FROM deps),
    'profiles_columns_present', (SELECT profile_cols FROM deps),
    'expect_profiles_columns', 4,
    'resolution_reason_check', (SELECT reason_check_def FROM deps)),
  'live_impact_no_identities', jsonb_build_object(
    'suggested_rows', (SELECT suggested_rows FROM impact),
    'will_stop_counting_target_missing', (SELECT target_missing FROM impact),
    'will_stop_counting_target_inactive', (SELECT target_inactive FROM impact),
    'will_stop_counting_target_incomplete', (SELECT target_incomplete FROM impact),
    'will_stop_counting_target_test', (SELECT target_test FROM impact),
    'will_stop_counting_target_paused', (SELECT target_paused FROM impact),
    'will_stop_counting_blocked_either_way', (SELECT blocked_either_way FROM impact),
    'note', 'categories overlap; see unavailable_target_census.sql for a mutually exclusive breakdown'),
  'overall_verdict', CASE
    WHEN (SELECT count(*) FROM pred) <> 1 THEN 'BLOCKER: count_unresolved_introductions is absent — 081 is not applied'
    WHEN (SELECT pg_catalog.strpos(prosrc,'is_available_intro_target')>0 FROM pred) THEN 'ALREADY_APPLIED'
    WHEN (SELECT body_md5 FROM pred) <> 'c834301b7374934c88e27e1005959f0a'
      THEN 'BLOCKER: predicate body is not the post-081 one — investigate drift before replacing'
    WHEN NOT (SELECT prosecdef FROM pred) THEN 'BLOCKER: predicate is not SECURITY DEFINER'
    WHEN EXISTS (SELECT 1 FROM writers WHERE NOT deployed) THEN 'BLOCKER: a writer is not deployed under its exact signature'
    WHEN EXISTS (SELECT 1 FROM writers WHERE signatures <> 1) THEN 'BLOCKER: a writer has multiple signatures'
    WHEN EXISTS (SELECT 1 FROM writers WHERE NOT calls_predicate) THEN 'BLOCKER: a writer does not call the predicate — 081 gate not in force'
    WHEN NOT (SELECT blocked_users FROM deps) THEN 'BLOCKER: public.blocked_users is absent'
    WHEN (SELECT profile_cols FROM deps) <> 4 THEN 'BLOCKER: a required profiles column is absent'
    WHEN NOT (SELECT reason_check FROM deps) THEN 'BLOCKER: intro_requests_resolution_reason_check is absent (062 not applied)'
    ELSE 'READY'
  END
)) AS preflight;
