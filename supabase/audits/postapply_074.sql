-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION FOR MIGRATION 074
-- STRICTLY READ-ONLY. One statement, SELECT + CTEs. Aggregate/structural only; no identifiers.
-- Every row must read OK. INFO rows are context.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
WITH
tb AS (SELECT to_regclass('public.weekly_batch_releases') AS oid),
fn AS (SELECT p.oid, p.prosecdef, p.proconfig, p.provolatile
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='weekly_batch_released'),
rows_out(sort, section, check_name, observed, expected) AS (VALUES
  (1, 'A. structure', 'table exists', ((SELECT oid FROM tb) IS NOT NULL)::text, 'true'),
  (1, 'A. structure', 'release_key is UNIQUE (idempotency)',
      COALESCE((SELECT (indexdef LIKE 'CREATE UNIQUE INDEX%')::text FROM pg_indexes
                WHERE schemaname='public' AND indexname='weekly_batch_releases_key_uniq'), 'ABSENT'), 'true'),
  (1, 'A. structure', 'source is constrained to the two real release paths',
      COALESCE((SELECT (pg_catalog.pg_get_constraintdef(oid) LIKE '%admin_approval%'
                    AND pg_catalog.pg_get_constraintdef(oid) LIKE '%weekly_cron%')::text
                FROM pg_catalog.pg_constraint
                WHERE conrelid=(SELECT oid FROM tb) AND contype='c'
                  AND pg_catalog.pg_get_constraintdef(oid) LIKE '%source%'), 'ABSENT'), 'true'),
  (1, 'A. structure', 'holds no member/pair/card column',
      (NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                   AND table_name='weekly_batch_releases'
                   AND column_name IN ('member_id','user_id','pair_id','intro_request_id','email','full_name')))::text, 'true'),
  (1, 'A. structure', 'batch_id is NOT a foreign key (a deleted draft must not orphan it)',
      (SELECT count(*)::text FROM pg_catalog.pg_constraint
       WHERE conrelid=(SELECT oid FROM tb) AND contype='f'), '0'),
  -- A release with no visible card must be UNREPRESENTABLE, not merely avoided by the writer.
  (1, 'A. structure', 'cards_released > 0 is enforced by CHECK',
      COALESCE((SELECT bool_or(pg_catalog.pg_get_constraintdef(oid) LIKE '%cards_released > 0%')::text
                FROM pg_catalog.pg_constraint WHERE conrelid=(SELECT oid FROM tb) AND contype='c'), 'ABSENT'), 'true'),
  -- There is no completion column: a release either exists or it does not.
  (1, 'A. structure', 'no completion column (one fact, not a spectrum)',
      (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
               AND table_name='weekly_batch_releases' AND column_name='completion'))::text, 'false'),

  -- ── THE FINALIZATION RPC: the ONLY writer ───────────────────────────────────────────────────
  (6, 'F. finalization RPC', 'exists with the exact signature',
      COALESCE(pg_catalog.pg_get_function_arguments(
        to_regprocedure('public.finalize_weekly_release(text,uuid)')), 'ABSENT'),
      'p_source text, p_batch_id uuid DEFAULT NULL::uuid'),
  (6, 'F. finalization RPC', 'SECURITY DEFINER',
      COALESCE((SELECT prosecdef::text FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_weekly_release(text,uuid)')), 'ABSENT'), 'true'),
  (6, 'F. finalization RPC', 'search_path is empty',
      COALESCE((SELECT array_to_string(proconfig,',') FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_weekly_release(text,uuid)')), 'ABSENT'), 'search_path=""'),
  (6, 'F. finalization RPC', 'every reference is schema-qualified',
      COALESCE((SELECT (regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'),
                          'public\.(weekly_batch_releases|intro_requests)', '', 'g')
                 ~ '\m(weekly_batch_releases|intro_requests)\M')::text
                FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_weekly_release(text,uuid)')), 'ABSENT'), 'false'),
  (6, 'F. finalization RPC', 'verifies committed cards itself (accepts no count)',
      COALESCE((SELECT (prosrc LIKE '%no_visible_introductions%' AND prosrc LIKE '%FROM public.intro_requests%')::text
                FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_weekly_release(text,uuid)')), 'ABSENT'), 'true'),
  (6, 'F. finalization RPC', 'consults batch identity BEFORE the calendar',
      COALESCE((SELECT (strpos(prosrc, 'WHERE r.batch_id = p_batch_id') > 0
                    AND strpos(prosrc, 'WHERE r.batch_id = p_batch_id') < strpos(prosrc, 'v_key := ''thu-'''))::text
                FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_weekly_release(text,uuid)')), 'ABSENT'), 'true'),
  (6, 'F. finalization RPC', 'admin evidence is scoped to the batch AND the window',
      COALESCE((SELECT (prosrc LIKE '%bs.batch_id = p_batch_id%'
                    AND prosrc LIKE '%bs.materialized_at >= v_window_start%')::text
                FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_weekly_release(text,uuid)')), 'ABSENT'), 'true'),
  -- The weekly predicate must key on member_pairs.source, the only durable value that separates
  -- weekly-refresh (broad + coverage) from onboarding, retry, admin and migration.
  (6, 'F. finalization RPC', 'weekly evidence keys on member_pairs.source = weekly',
      COALESCE((SELECT (prosrc LIKE '%mp.source = ''weekly''%')::text FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_weekly_release(text,uuid)')), 'ABSENT'), 'true'),
  (6, 'F. finalization RPC', 'weekly evidence is window-scoped on last_recommended_at',
      COALESCE((SELECT (prosrc LIKE '%mp.last_recommended_at >= v_window_start%')::text FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_weekly_release(text,uuid)')), 'ABSENT'), 'true'),
  (6, 'F. finalization RPC', 'weekly evidence requires a healthy two-sided pair',
      COALESCE((SELECT (prosrc LIKE '%x.pair_id = mp.id AND x.created_at >= v_window_start) = 2%')::text
                FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_weekly_release(text,uuid)')), 'ABSENT'), 'true'),
  -- REGRESSION GUARD: is_admin_initiated alone would let an onboarding card qualify a weekly release.
  (6, 'F. finalization RPC', 'is_admin_initiated is NOT used as attribution',
      COALESCE((SELECT (prosrc LIKE '%is_admin_initiated%')::text FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_weekly_release(text,uuid)')), 'ABSENT'), 'false'),
  -- Evidence must not rest on a status a member can change seconds after receiving a card.
  (6, 'F. finalization RPC', 'evidence does not depend on intro_requests.status',
      COALESCE((SELECT (prosrc LIKE '%ir.status%' OR prosrc LIKE '%status = ''suggested''%')::text
                FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_weekly_release(text,uuid)')), 'ABSENT'), 'false'),
  (6, 'F. finalization RPC', 'refuses an old batch explicitly rather than re-dating it',
      COALESCE((SELECT (prosrc LIKE '%batch_belongs_to_earlier_window%')::text FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_weekly_release(text,uuid)')), 'ABSENT'), 'true'),
  (6, 'F. finalization RPC', 'enforces the source/batch_id contract',
      COALESCE((SELECT (prosrc LIKE '%admin_requires_batch_id%' AND prosrc LIKE '%weekly_forbids_batch_id%'
                    AND prosrc LIKE '%batch_not_found%')::text FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_weekly_release(text,uuid)')), 'ABSENT'), 'true'),
  (7, 'G. uniqueness', 'one release per admin batch (partial unique on batch_id)',
      COALESCE((SELECT (indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '%batch_id IS NOT NULL%')::text
                FROM pg_indexes WHERE schemaname='public' AND indexname='weekly_batch_releases_batch_uniq'), 'ABSENT'), 'true'),
  (7, 'G. uniqueness', 'no admin batch owns two release facts',
      (SELECT count(*)::text FROM (SELECT batch_id FROM public.weekly_batch_releases
        WHERE batch_id IS NOT NULL GROUP BY batch_id HAVING count(*) > 1) d), '0'),
  (7, 'G. uniqueness', 'no release key is owned twice',
      (SELECT count(*)::text FROM (SELECT release_key FROM public.weekly_batch_releases
        GROUP BY release_key HAVING count(*) > 1) d), '0'),
  (7, 'G. uniqueness', 'every admin fact names a batch; every weekly fact names none',
      (SELECT count(*)::text FROM public.weekly_batch_releases
       WHERE (source = 'admin_approval' AND batch_id IS NULL)
          OR (source = 'weekly_cron' AND batch_id IS NOT NULL)), '0'),
  (6, 'F. finalization RPC', 'derives the week itself (accepts no release key)',
      COALESCE((SELECT (prosrc NOT LIKE '%p_release_key%')::text FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_weekly_release(text,uuid)')), 'ABSENT'), 'true'),
  (6, 'F. finalization RPC', 'anon cannot execute',
      COALESCE((SELECT has_function_privilege('anon', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_weekly_release(text,uuid)')), 'ABSENT'), 'false'),
  (6, 'F. finalization RPC', 'authenticated cannot execute',
      COALESCE((SELECT has_function_privilege('authenticated', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_weekly_release(text,uuid)')), 'ABSENT'), 'false'),
  (6, 'F. finalization RPC', 'PUBLIC cannot execute',
      COALESCE((SELECT has_function_privilege('public', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_weekly_release(text,uuid)')), 'ABSENT'), 'false'),
  (6, 'F. finalization RPC', 'service_role may execute',
      COALESCE((SELECT has_function_privilege('service_role', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_weekly_release(text,uuid)')), 'ABSENT'), 'true'),

  (2, 'B. privileges', 'RLS enabled',
      COALESCE((SELECT relrowsecurity::text FROM pg_catalog.pg_class WHERE oid=(SELECT oid FROM tb)), 'ABSENT'), 'true'),
  (2, 'B. privileges', 'ZERO policies',
      COALESCE((SELECT count(*)::text FROM pg_catalog.pg_policy WHERE polrelid=(SELECT oid FROM tb)), 'ABSENT'), '0'),
  (2, 'B. privileges', 'anon holds no table privilege',
      (NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema='public'
                   AND table_name='weekly_batch_releases' AND grantee='anon'))::text, 'true'),
  (2, 'B. privileges', 'authenticated holds no table privilege',
      (NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema='public'
                   AND table_name='weekly_batch_releases' AND grantee='authenticated'))::text, 'true'),
  (2, 'B. privileges', 'PUBLIC holds no direct grant',
      (SELECT count(*)::text FROM information_schema.role_table_grants WHERE table_schema='public'
       AND table_name='weekly_batch_releases' AND grantee='PUBLIC'), '0'),
  -- ── ALL SEVEN service_role PRIVILEGES, EACH ON ITS OWN ROW ──────────────────────────────────
  -- Checked individually so a failure names the offending privilege instead of collapsing to one
  -- boolean. This is the check that caught the inherited grants in production: 074's narrow GRANT
  -- could not remove UPDATE and DELETE that ALTER DEFAULT PRIVILEGES had already handed out.
  (2, 'B. service_role privileges', '1. SELECT',
      has_table_privilege('service_role','public.weekly_batch_releases','SELECT')::text, 'true'),
  (2, 'B. service_role privileges', '2. INSERT',
      has_table_privilege('service_role','public.weekly_batch_releases','INSERT')::text, 'true'),
  (2, 'B. service_role privileges', '3. UPDATE (a release is a fact, not a draft)',
      has_table_privilege('service_role','public.weekly_batch_releases','UPDATE')::text, 'false'),
  (2, 'B. service_role privileges', '4. DELETE',
      has_table_privilege('service_role','public.weekly_batch_releases','DELETE')::text, 'false'),
  (2, 'B. service_role privileges', '5. TRUNCATE',
      has_table_privilege('service_role','public.weekly_batch_releases','TRUNCATE')::text, 'false'),
  (2, 'B. service_role privileges', '6. REFERENCES',
      has_table_privilege('service_role','public.weekly_batch_releases','REFERENCES')::text, 'false'),
  (2, 'B. service_role privileges', '7. TRIGGER',
      has_table_privilege('service_role','public.weekly_batch_releases','TRIGGER')::text, 'false'),

  (3, 'C. exposure function', 'exists and is SECURITY DEFINER',
      COALESCE((SELECT prosecdef::text FROM fn), 'ABSENT'), 'true'),
  (3, 'C. exposure function', 'search_path is empty',
      COALESCE((SELECT array_to_string(proconfig,',') FROM fn), 'ABSENT'), 'search_path=""'),
  (3, 'C. exposure function', 'STABLE, not volatile',
      COALESCE((SELECT provolatile::text FROM fn), 'ABSENT'), 's'),
  (3, 'C. exposure function', 'returns only the key and timestamp',
      COALESCE((SELECT pg_catalog.pg_get_function_result(oid) FROM fn), 'ABSENT'),
      'TABLE(release_key text, released_at timestamp with time zone)'),
  (3, 'C. exposure function', 'anon cannot execute',
      COALESCE((SELECT has_function_privilege('anon', oid, 'EXECUTE')::text FROM fn), 'ABSENT'), 'false'),
  (3, 'C. exposure function', 'authenticated may execute',
      COALESCE((SELECT has_function_privilege('authenticated', oid, 'EXECUTE')::text FROM fn), 'ABSENT'), 'true'),

  (4, 'D. no backfill', 'release rows created by the migration itself',
      (SELECT count(*)::text FROM public.weekly_batch_releases
       WHERE created_at < (SELECT COALESCE(MIN(created_at), now()) FROM public.intro_requests)), '0'),
  (4, 'D. no backfill', 'duplicate release keys',
      (SELECT count(*)::text FROM (SELECT release_key FROM public.weekly_batch_releases
        GROUP BY release_key HAVING count(*) > 1) d), '0'),

  (5, 'E. context', 'release rows recorded so far',
      (SELECT count(*)::text FROM public.weekly_batch_releases), 'context'),
  (5, 'E. context', 'most recent release key',
      COALESCE((SELECT release_key FROM public.weekly_batch_releases ORDER BY released_at DESC LIMIT 1), 'none'), 'context')
)
SELECT section, check_name, observed, expected,
       CASE WHEN expected='context' THEN 'INFO' WHEN observed=expected THEN 'OK' ELSE 'FAIL' END AS verdict
FROM rows_out ORDER BY sort, check_name;
