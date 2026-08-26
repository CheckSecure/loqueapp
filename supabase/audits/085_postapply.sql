-- 085 POST-APPLY — read-only. Run AFTER applying 085. overall_verdict: PASS | FAIL: <reason>
WITH pred AS (
  SELECT p.prosrc, p.prosecdef, p.proconfig
  FROM pg_catalog.pg_proc p
  WHERE p.oid = pg_catalog.to_regprocedure('public.count_unresolved_introductions(uuid, uuid, uuid)')
),
rel AS (
  SELECT p.prosecdef, p.proconfig
  FROM pg_catalog.pg_proc p
  WHERE p.oid = pg_catalog.to_regprocedure('public.neutralize_unavailable_pair(uuid)')
),
acl AS (
  SELECT
    pg_catalog.has_function_privilege('anon','public.count_unresolved_introductions(uuid, uuid, uuid)','EXECUTE') AS anon_pred,
    pg_catalog.has_function_privilege('authenticated','public.count_unresolved_introductions(uuid, uuid, uuid)','EXECUTE') AS auth_pred,
    pg_catalog.has_function_privilege('service_role','public.count_unresolved_introductions(uuid, uuid, uuid)','EXECUTE') AS svc_pred,
    pg_catalog.has_function_privilege('anon','public.neutralize_unavailable_pair(uuid)','EXECUTE') AS anon_rel,
    pg_catalog.has_function_privilege('authenticated','public.neutralize_unavailable_pair(uuid)','EXECUTE') AS auth_rel,
    pg_catalog.has_function_privilege('service_role','public.neutralize_unavailable_pair(uuid)','EXECUTE') AS svc_rel
),
bypass AS (
  -- THE lock-bypass check: no function may exist that can neutralise without taking the locks, and
  -- the one entry point must have exactly one 1-argument signature.
  SELECT
    (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('release_unavailable_introduction','reconcile_unavailable_introductions')) AS legacy_bypass,
    (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.proname='neutralize_unavailable_pair') AS entry_points,
    (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.proname='neutralize_unavailable_pair' AND p.pronargs <> 1) AS bad_arity,
    (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND pg_catalog.pg_get_function_arguments(p.oid) ILIKE '%skip_locks%') AS skip_locks_args
),
writers AS (
  SELECT
    count(*) FILTER (WHERE pg_catalog.strpos(p.prosrc,'count_usable_visible_cards')>0) AS use_usable,
    count(*) FILTER (WHERE pg_catalog.strpos(p.prosrc,'status = ''suggested'' AND ir.capacity_released_at IS NULL')>0) AS still_raw,
    count(*) FILTER (WHERE pg_catalog.strpos(p.prosrc,'neutralize_unavailable_pair')>0) AS writers_that_write,
    count(*) AS total
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname IN
    ('create_reciprocal_suggestion','place_batch_rows','promote_queued_rows','materialize_admin_pair')
),
cons AS (
  SELECT pg_catalog.pg_get_constraintdef(oid) AS def FROM pg_catalog.pg_constraint
   WHERE conname='intro_requests_resolution_reason_check'
     AND conrelid='public.intro_requests'::pg_catalog.regclass
),
rows AS (
  SELECT
    count(*) FILTER (WHERE resolution_reason = 'system_pair_unavailable') AS system_released,
    count(*) FILTER (WHERE resolution_reason IN ('not_for_me','never_show','already_know')) AS member_reasons,
    count(*) FILTER (WHERE status='suggested') AS suggested_rows
  FROM public.intro_requests
),
strand AS (
  -- The point of the migration: no member may still be blocked by a card they cannot answer.
  SELECT count(*) AS still_counted_unavailable
  FROM public.intro_requests s
  LEFT JOIN public.profiles t ON t.id = s.target_user_id
  WHERE s.status='suggested'
    AND (t.id IS NULL OR t.account_status <> 'active' OR t.profile_complete IS NOT TRUE
         OR t.is_test_account IS TRUE OR t.matching_paused IS TRUE
         OR EXISTS (SELECT 1 FROM public.blocked_users bu
                     WHERE (bu.user_id=s.requester_id AND bu.blocked_user_id=s.target_user_id)
                        OR (bu.user_id=s.target_user_id AND bu.blocked_user_id=s.requester_id)))
    AND public.count_unresolved_introductions(s.requester_id, NULL, NULL) > 0
    AND NOT EXISTS (
      -- the member has at least one card that IS available — then the count is legitimately > 0
      SELECT 1 FROM public.intro_requests s2
      JOIN public.profiles t2 ON t2.id = s2.target_user_id
      WHERE s2.requester_id = s.requester_id AND s2.status='suggested'
        AND t2.account_status='active' AND t2.profile_complete IS TRUE
        AND t2.is_test_account IS NOT TRUE AND t2.matching_paused IS NOT TRUE)
),
emptypath AS (
  -- `SET search_path = ''` is STORED as search_path="" (quoted empty), not search_path=. Comparing
  -- against one encoding would fail a correctly-applied migration, so accept either.
  SELECT ARRAY['search_path=""','search_path='] AS ok
)
SELECT jsonb_pretty(jsonb_build_object(
  'checked_at', now(),
  'predicate_excludes', jsonb_build_object(
    'via_is_available_intro_target', (SELECT pg_catalog.strpos(prosrc,'is_available_intro_target')>0 FROM pred),
    'placement_cards_only', (SELECT pg_catalog.strpos(prosrc,'responds_to_id IS NULL')>0 FROM pred),
    'availability_definition', (SELECT pg_catalog.pg_get_functiondef(
        pg_catalog.to_regprocedure('public.is_available_intro_target(uuid, uuid)')) IS NOT NULL)),
  'predicate_security', jsonb_build_object(
    'security_definer', (SELECT prosecdef FROM pred),
    'search_path', (SELECT proconfig FROM pred)),
  'releaser_security', jsonb_build_object(
    'deployed', (SELECT count(*) FROM rel) = 1,
    'security_definer', (SELECT prosecdef FROM rel),
    'search_path', (SELECT proconfig FROM rel)),
  'privileges', (SELECT to_jsonb(acl) FROM acl),
  'lock_bypass', (SELECT to_jsonb(bypass) FROM bypass),
  'writers', (SELECT to_jsonb(writers) FROM writers),
  'expect_legacy_bypass', 0,
  'expect_entry_points', 1,
  'expect_skip_locks_args', 0,
  'expect_writers_using_usable_capacity', 4,
  'expect_writers_that_write', 0,
  'resolution_reason_constraint', (SELECT def FROM cons),
  'rows', jsonb_build_object(
    'suggested', (SELECT suggested_rows FROM rows),
    'system_released', (SELECT system_released FROM rows),
    'member_authored_reasons', (SELECT member_reasons FROM rows)),
  'members_still_stranded_by_an_unanswerable_card', (SELECT still_counted_unavailable FROM strand),
  'expect_system_released_immediately_after_apply', 0,
  'expect_members_still_stranded', 0,
  'overall_verdict', CASE
    WHEN (SELECT legacy_bypass FROM bypass) > 0 THEN 'FAIL: a lock-bypassing neutraliser is deployed'
    WHEN (SELECT skip_locks_args FROM bypass) > 0 THEN 'FAIL: a function exposes a skip_locks argument'
    WHEN (SELECT entry_points FROM bypass) <> 1 THEN 'FAIL: expected exactly one neutralize_unavailable_pair'
    WHEN (SELECT bad_arity FROM bypass) > 0 THEN 'FAIL: neutralize_unavailable_pair has an unexpected arity'
    WHEN (SELECT total FROM writers) <> 4 THEN 'FAIL: a writer is missing'
    WHEN (SELECT use_usable FROM writers) <> 4 THEN 'FAIL: a writer does not use count_usable_visible_cards'
    WHEN (SELECT still_raw FROM writers) > 0 THEN 'FAIL: a writer still counts raw suggested rows for capacity'
    WHEN (SELECT writers_that_write FROM writers) > 0 THEN 'FAIL: a writer calls the neutraliser (writers must be read-only)'
    WHEN (SELECT count(*) FROM pred) <> 1 THEN 'FAIL: predicate missing'
    WHEN (SELECT count(*) FROM rel) <> 1 THEN 'FAIL: neutralize_unavailable_pair missing'
    WHEN NOT ((SELECT pg_catalog.strpos(prosrc,'is_available_intro_target')>0 FROM pred)
          AND (SELECT pg_catalog.strpos(prosrc,'responds_to_id IS NULL')>0 FROM pred))
      THEN 'FAIL: the gate does not use the shared availability predicate over placement cards only'
    WHEN NOT (SELECT prosecdef FROM pred) OR NOT (SELECT prosecdef FROM rel)
      THEN 'FAIL: a function is not SECURITY DEFINER'
    WHEN NOT (pg_catalog.array_to_string((SELECT proconfig FROM pred), ',') = ANY (SELECT unnest(ok) FROM emptypath))
      OR NOT (pg_catalog.array_to_string((SELECT proconfig FROM rel), ',') = ANY (SELECT unnest(ok) FROM emptypath))
      THEN 'FAIL: a function does not have an empty search_path'
    WHEN (SELECT anon_pred OR auth_pred OR anon_rel OR auth_rel FROM acl)
      THEN 'FAIL: a browser role can EXECUTE one of these functions'
    WHEN NOT (SELECT svc_pred AND svc_rel FROM acl) THEN 'FAIL: service_role cannot EXECUTE'
    WHEN (SELECT def FROM cons) NOT LIKE '%system_pair_unavailable%' THEN 'FAIL: neutral reason not permitted'
    WHEN (SELECT def FROM cons) NOT LIKE '%already_know%' THEN 'FAIL: a member reason was dropped'
    WHEN (SELECT still_counted_unavailable FROM strand) > 0
      THEN 'FAIL: a member is still held out solely by a card they cannot answer'
    ELSE 'PASS'
  END
)) AS postapply;
