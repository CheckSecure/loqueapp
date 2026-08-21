-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- PREFLIGHT FOR MIGRATION 072 — credit debit ledger and admin-participant exemption
-- STRICTLY READ-ONLY. One statement, SELECT + CTEs. No DML/DDL/locks/temp/dynamic SQL. Aggregate
-- and structural only; no user_id, name or email. verdict: OK / BLOCKER / REVIEW / INFO.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
WITH
ct AS (SELECT to_regclass('public.credit_transactions') AS oid),
dg AS (SELECT to_regprocedure('public.consume_credits_and_create_match(uuid,uuid,boolean)') AS oid),
rows_out(sort, section, check_name, observed, expected) AS (VALUES

  (1, 'A. prerequisites exist', 'credit_transactions table exists',
      ((SELECT oid FROM ct) IS NOT NULL)::text, 'true'),
  (1, 'A. prerequisites exist', 'the delegate exists with the exact signature',
      ((SELECT oid FROM dg) IS NOT NULL)::text, 'true'),
  (1, 'A. prerequisites exist', 'profiles.is_admin exists (the exemption depends on it)',
      (EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='profiles' AND column_name='is_admin'))::text, 'true'),
  (1, 'A. prerequisites exist', 'matches has a UNIQUE on (user_a_id, user_b_id)',
      (EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
               WHERE conrelid = to_regclass('public.matches') AND contype = 'u'))::text, 'true'),

  (2, 'B. 072 objects must be ABSENT', 'column credit_transactions.event_key',
      (EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='credit_transactions' AND column_name='event_key'))::text, 'false'),
  (2, 'B. 072 objects must be ABSENT', 'column credit_transactions.source_kind',
      (EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='credit_transactions' AND column_name='source_kind'))::text, 'false'),
  (2, 'B. 072 objects must be ABSENT', 'index credit_transactions_event_key_uniq',
      (to_regclass('public.credit_transactions_event_key_uniq') IS NOT NULL)::text, 'false'),
  (2, 'B. 072 objects must be ABSENT', 'function tg_credit_transactions_append_only',
      (EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public' AND p.proname='tg_credit_transactions_append_only'))::text, 'false'),
  (2, 'B. 072 objects must be ABSENT', 'trigger credit_transactions_append_only',
      (EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
               WHERE tgrelid = (SELECT oid FROM ct) AND tgname='credit_transactions_append_only'))::text, 'false'),

  -- 072 replaces the delegate. If production drifted from the reviewed 067 body, STOP.
  (3, 'C. delegate drift', 'result columns still match the reviewed contract',
      COALESCE((SELECT pg_catalog.pg_get_function_result(oid) FROM dg), 'ABSENT'),
      'TABLE(match_id uuid, conversation_id uuid, error_code text)'),
  (3, 'C. delegate drift', 'argument list still matches',
      COALESCE((SELECT pg_catalog.pg_get_function_arguments(oid) FROM dg), 'ABSENT'),
      'p_user_a uuid, p_user_b uuid, p_admin_facilitated boolean DEFAULT false'),
  (3, 'C. delegate drift', 'SECURITY DEFINER',
      COALESCE((SELECT prosecdef::text FROM pg_catalog.pg_proc WHERE oid = (SELECT oid FROM dg)), 'ABSENT'), 'true'),
  (3, 'C. delegate drift', 'search_path is empty',
      COALESCE((SELECT array_to_string(proconfig, ',') FROM pg_catalog.pg_proc WHERE oid = (SELECT oid FROM dg)), 'ABSENT'),
      'search_path=""'),
  (3, 'C. delegate drift', 'body currently writes NO ledger row (the defect 072 fixes)',
      COALESCE((SELECT (prosrc NOT LIKE '%credit_transactions%')::text FROM pg_catalog.pg_proc WHERE oid = (SELECT oid FROM dg)), 'ABSENT'),
      'true'),
  (3, 'C. delegate drift', 'body currently has NO admin exemption (the defect 072 fixes)',
      COALESCE((SELECT (prosrc NOT LIKE '%is_admin%')::text FROM pg_catalog.pg_proc WHERE oid = (SELECT oid FROM dg)), 'ABSENT'),
      'true'),

  -- 068 removed service_role EXECUTE; 072 must not be applied to a database where it came back.
  (4, 'D. 068 posture intact', 'service_role cannot execute the delegate',
      COALESCE((SELECT has_function_privilege('service_role', oid, 'EXECUTE')::text FROM dg), 'ABSENT'), 'false'),
  (4, 'D. 068 posture intact', 'anon cannot execute the delegate',
      COALESCE((SELECT has_function_privilege('anon', oid, 'EXECUTE')::text FROM dg), 'ABSENT'), 'false'),
  (4, 'D. 068 posture intact', 'authenticated cannot execute the delegate',
      COALESCE((SELECT has_function_privilege('authenticated', oid, 'EXECUTE')::text FROM dg), 'ABSENT'), 'false'),
  (4, 'D. 068 posture intact', 'the wrapper is executable by service_role',
      COALESCE((SELECT has_function_privilege('service_role',
                 to_regprocedure('public.finalize_mutual_match_atomic(uuid,uuid,boolean)'), 'EXECUTE')::text), 'ABSENT'), 'true'),

  -- The partial unique index is built over existing rows. It cannot fail while every event_key is
  -- NULL, but confirm the column really is absent (checked above) and the table is reachable.
  (5, 'E. existing rows tolerate 072', 'browser roles hold no INSERT/UPDATE/DELETE on credit_transactions',
      (NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                   WHERE table_schema='public' AND table_name='credit_transactions'
                     AND grantee IN ('anon','authenticated','PUBLIC')
                     AND privilege_type IN ('INSERT','UPDATE','DELETE')))::text, 'true'),
  (5, 'E. existing rows tolerate 072', 'service_role can INSERT into credit_transactions',
      has_table_privilege('service_role','public.credit_transactions','INSERT')::text, 'true'),

  -- Context. These numbers are the "before" picture the post-apply check is read against.
  (6, 'F. context', 'credit_transactions rows today',
      (SELECT count(*)::text FROM public.credit_transactions), 'context'),
  (6, 'F. context', 'credit_transactions DEBIT rows today',
      (SELECT count(*)::text FROM public.credit_transactions WHERE amount < 0), 'context'),
  (6, 'F. context', 'accounts violating balance = free + premium',
      (SELECT count(*)::text FROM public.meeting_credits
       WHERE COALESCE(balance,0) <> COALESCE(free_credits,0) + COALESCE(premium_credits,0)), 'context'),
  (6, 'F. context', 'accounts with a NEGATIVE balance',
      (SELECT count(*)::text FROM public.meeting_credits WHERE COALESCE(balance,0) < 0), 'context'),
  (6, 'F. context', 'administrator accounts',
      (SELECT count(*)::text FROM public.profiles WHERE is_admin IS TRUE), 'context')
)
SELECT section, check_name, observed, expected,
       CASE WHEN expected = 'context' THEN 'INFO'
            WHEN observed = expected  THEN 'OK'
            WHEN section LIKE 'B.%'   THEN 'REVIEW'
            ELSE 'BLOCKER' END AS verdict
FROM rows_out ORDER BY sort, check_name;
