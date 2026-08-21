-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION FOR MIGRATIONS 072 + 073
-- STRICTLY READ-ONLY. One statement, SELECT + CTEs. Aggregate/structural only; no identifiers.
--
-- FAIL means a migration did not land as reviewed. INFO/REVIEW rows are context, NOT failures.
--
-- ─── WHY SECTION F WAS WRONG BEFORE, AND WHAT IT DOES NOW ──────────────────────────────────────
-- The first version asserted "no negative balance = 0" as a hard FAIL. That was a category error:
-- migration 072 is PROSPECTIVE containment. It fixes how credits move from now on; it neither
-- claims nor attempts to repair state that predates it. Production holds one historical account
-- with a negative balance, written long before 072 by the only unbounded writer that existed
-- (the admin credit setter), and reporting it as "072 failed" would be false — and worse, it would
-- pressure someone into silently repairing an account that is under review.
--
-- So historical inconsistency is now INFO/REVIEW. What still FAILS is the thing 072 IS responsible
-- for: a negative or non-additive balance on an account that carries a POST-072 ledgered debit.
-- That would mean the new authority itself produced it, which is a real regression.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
WITH
ct  AS (SELECT to_regclass('public.credit_transactions') AS oid),
dg  AS (SELECT to_regprocedure('public.consume_credits_and_create_match(uuid,uuid,boolean)') AS oid),
src AS (SELECT regexp_replace(COALESCE((SELECT prosrc FROM pg_catalog.pg_proc WHERE oid=(SELECT oid FROM dg)),''),
                              '--[^\n]*', '', 'g') AS s),
tgf AS (SELECT p.oid, p.prosecdef, p.proconfig FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='tg_credit_transactions_append_only'),
rows_out(sort, section, check_name, observed, expected) AS (VALUES

  (1, 'A. delegate signature', 'exact argument list',
      COALESCE((SELECT pg_catalog.pg_get_function_arguments(oid) FROM dg), 'ABSENT'),
      'p_user_a uuid, p_user_b uuid, p_admin_facilitated boolean DEFAULT false'),
  (1, 'A. delegate signature', 'exact result columns and order',
      COALESCE((SELECT pg_catalog.pg_get_function_result(oid) FROM dg), 'ABSENT'),
      'TABLE(match_id uuid, conversation_id uuid, error_code text)'),
  (1, 'A. delegate signature', 'SECURITY DEFINER',
      COALESCE((SELECT prosecdef::text FROM pg_catalog.pg_proc WHERE oid=(SELECT oid FROM dg)), 'ABSENT'), 'true'),
  (1, 'A. delegate signature', 'VOLATILE',
      COALESCE((SELECT provolatile::text FROM pg_catalog.pg_proc WHERE oid=(SELECT oid FROM dg)), 'ABSENT'), 'v'),
  (1, 'A. delegate signature', 'search_path is empty',
      COALESCE((SELECT array_to_string(proconfig,',') FROM pg_catalog.pg_proc WHERE oid=(SELECT oid FROM dg)), 'ABSENT'),
      'search_path=""'),
  (1, 'A. delegate signature', 'every reference is schema-qualified',
      (regexp_replace((SELECT s FROM src),
        'public\.(meeting_credits|matches|conversations|credit_transactions|profiles)', '', 'g')
        ~ '\m(meeting_credits|matches|conversations|credit_transactions|profiles)\M')::text, 'false'),

  (2, 'B. exemption is participant-derived', 'reads profiles.is_admin',
      ((SELECT s FROM src) ~ 'is_admin')::text, 'true'),
  (2, 'B. exemption is participant-derived', 'reads it under FOR SHARE (locked state)',
      ((SELECT s FROM src) ~ 'FOR SHARE')::text, 'true'),
  (2, 'B. exemption is participant-derived', 'chargeability derives from the admin count',
      ((SELECT s FROM src) ~ 'v_chargeable := \(v_admin_count = 0\)')::text, 'true'),
  -- THE KEY PROPERTY: the caller-supplied flag must not appear before the chargeability decision.
  (2, 'B. exemption is participant-derived', 'p_admin_facilitated appears EXACTLY once in the body',
      (SELECT count(*)::text FROM regexp_matches((SELECT s FROM src), 'p_admin_facilitated', 'g')), '1'),
  (2, 'B. exemption is participant-derived', 'its single use is the match INSERT, not the decision',
      ((SELECT s FROM src) ~ 'VALUES \(p_user_a, p_user_b, p_admin_facilitated\)')::text, 'true'),
  (2, 'B. exemption is participant-derived', 'no administrator identity is hard-coded',
      ((SELECT s FROM src) !~* 'bizdev91|065d5d1a')::text, 'true'),
  (2, 'B. exemption is participant-derived', 'refuses when a participant cannot be read',
      ((SELECT s FROM src) ~ 'participant_not_found')::text, 'true'),

  (3, 'C. ledger', 'event_key column exists',
      (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
               AND table_name='credit_transactions' AND column_name='event_key'))::text, 'true'),
  (3, 'C. ledger', 'source_kind + source_id exist',
      (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
               AND table_name='credit_transactions' AND column_name='source_kind')
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
               AND table_name='credit_transactions' AND column_name='source_id'))::text, 'true'),
  (3, 'C. ledger', 'event-key index is UNIQUE and PARTIAL (legacy rows excluded)',
      COALESCE((SELECT (indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '%event_key IS NOT NULL%')::text
                FROM pg_indexes WHERE schemaname='public' AND indexname='credit_transactions_event_key_uniq'), 'ABSENT'), 'true'),
  (3, 'C. ledger', 'no duplicate event_key exists',
      (SELECT count(*)::text FROM (SELECT event_key FROM public.credit_transactions
        WHERE event_key IS NOT NULL GROUP BY event_key HAVING count(*) > 1) d), '0'),
  (3, 'C. ledger', 'the delegate writes debit rows',
      ((SELECT s FROM src) ~ 'match_debit:')::text, 'true'),
  (3, 'C. ledger', 'the delegate records exemptions too',
      ((SELECT s FROM src) ~ 'match_exempt:')::text, 'true'),
  (3, 'C. ledger', 'append-only trigger exists',
      (EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=(SELECT oid FROM ct)
               AND tgname='credit_transactions_append_only' AND tgenabled='O'))::text, 'true'),
  (3, 'C. ledger', 'append-only function is SECURITY DEFINER',
      COALESCE((SELECT prosecdef::text FROM tgf), 'ABSENT'), 'true'),
  (3, 'C. ledger', 'append-only function search_path is empty',
      COALESCE((SELECT array_to_string(proconfig,',') FROM tgf), 'ABSENT'), 'search_path=""'),

  (4, 'D. privileges', 'anon holds no privilege on credit_transactions',
      (NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema='public'
                   AND table_name='credit_transactions' AND grantee='anon'))::text, 'true'),
  (4, 'D. privileges', 'authenticated holds no INSERT/UPDATE/DELETE',
      (NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema='public'
                   AND table_name='credit_transactions' AND grantee='authenticated'
                     AND privilege_type IN ('INSERT','UPDATE','DELETE')))::text, 'true'),
  (4, 'D. privileges', 'RLS enabled on credit_transactions',
      COALESCE((SELECT relrowsecurity::text FROM pg_catalog.pg_class WHERE oid=(SELECT oid FROM ct)), 'ABSENT'), 'true'),
  (4, 'D. privileges', 'service_role can SELECT and INSERT',
      (has_table_privilege('service_role','public.credit_transactions','SELECT')
       AND has_table_privilege('service_role','public.credit_transactions','INSERT'))::text, 'true'),
  (4, 'D. privileges', 'service_role cannot DELETE the ledger',
      has_table_privilege('service_role','public.credit_transactions','DELETE')::text, 'false'),
  (4, 'D. privileges', 'browser roles cannot execute the append-only function',
      COALESCE((SELECT (has_function_privilege('anon', oid, 'EXECUTE')
                     OR has_function_privilege('authenticated', oid, 'EXECUTE'))::text FROM tgf), 'ABSENT'), 'false'),

  (5, 'E. 068 restrictions intact', 'service_role still cannot execute the raw delegate',
      COALESCE((SELECT has_function_privilege('service_role', oid, 'EXECUTE')::text FROM dg), 'ABSENT'), 'false'),
  (5, 'E. 068 restrictions intact', 'anon still cannot execute the raw delegate',
      COALESCE((SELECT has_function_privilege('anon', oid, 'EXECUTE')::text FROM dg), 'ABSENT'), 'false'),
  (5, 'E. 068 restrictions intact', 'authenticated still cannot execute the raw delegate',
      COALESCE((SELECT has_function_privilege('authenticated', oid, 'EXECUTE')::text FROM dg), 'ABSENT'), 'false'),
  (5, 'E. 068 restrictions intact', 'the wrapper remains service_role-executable',
      COALESCE((SELECT has_function_privilege('service_role',
        to_regprocedure('public.finalize_mutual_match_atomic(uuid,uuid,boolean)'), 'EXECUTE')::text), 'ABSENT'), 'true'),

  -- F1. THE ASSERTION 072 IS ACCOUNTABLE FOR. An account that has been debited by the NEW authority
  -- (it carries a match_debit event) must never be negative or non-additive. This is a real FAIL.
  (6, 'F. post-072 debits are sound', 'accounts debited post-072 with a negative bucket',
      (SELECT count(*)::text FROM public.meeting_credits mc
       WHERE EXISTS (SELECT 1 FROM public.credit_transactions c
                     WHERE c.user_id = mc.user_id AND c.source_kind = 'match_debit')
         AND (COALESCE(mc.balance,0) < 0 OR COALESCE(mc.free_credits,0) < 0
              OR COALESCE(mc.premium_credits,0) < 0)), '0'),
  (6, 'F. post-072 debits are sound', 'accounts debited post-072 violating balance = free + premium',
      (SELECT count(*)::text FROM public.meeting_credits mc
       WHERE EXISTS (SELECT 1 FROM public.credit_transactions c
                     WHERE c.user_id = mc.user_id AND c.source_kind = 'match_debit')
         AND COALESCE(mc.balance,0) <> COALESCE(mc.free_credits,0) + COALESCE(mc.premium_credits,0)), '0'),
  (6, 'F. post-072 debits are sound', 'match_debit events without a matching match row',
      (SELECT count(*)::text FROM public.credit_transactions c
       WHERE c.source_kind = 'match_debit'
         AND NOT EXISTS (SELECT 1 FROM public.matches m WHERE m.id = c.source_id)), '0'),
  (6, 'F. post-072 debits are sound', 'match_debit events with an amount other than -1',
      (SELECT count(*)::text FROM public.credit_transactions
       WHERE source_kind = 'match_debit' AND amount <> -1), '0'),
  (6, 'F. post-072 debits are sound', 'match_exempt events with a non-zero amount',
      (SELECT count(*)::text FROM public.credit_transactions
       WHERE source_kind = 'match_exempt_admin' AND amount <> 0), '0'),

  -- F2. HISTORICAL STATE. Context for the operator, never a verdict on this migration. These
  -- accounts predate 072 and are under separate review; do not repair them from this report.
  (7, 'G. historical state (context, not a verdict)', 'accounts with a negative balance (pre-072)',
      (SELECT count(*)::text FROM public.meeting_credits mc
       WHERE COALESCE(mc.balance,0) < 0
         AND NOT EXISTS (SELECT 1 FROM public.credit_transactions c
                         WHERE c.user_id = mc.user_id AND c.source_kind = 'match_debit')), 'context'),
  (7, 'G. historical state (context, not a verdict)', 'accounts violating balance = free + premium (pre-072)',
      (SELECT count(*)::text FROM public.meeting_credits mc
       WHERE COALESCE(mc.balance,0) <> COALESCE(mc.free_credits,0) + COALESCE(mc.premium_credits,0)
         AND NOT EXISTS (SELECT 1 FROM public.credit_transactions c
                         WHERE c.user_id = mc.user_id AND c.source_kind = 'match_debit')), 'context'),
  (7, 'G. historical state (context, not a verdict)', 'most negative balance observed anywhere',
      (SELECT COALESCE(MIN(balance),0)::text FROM public.meeting_credits), 'context'),

  -- ── MIGRATION 073: the exact ACL contract ───────────────────────────────────────────────────
  -- 072's narrow REVOKE could not remove privileges it did not name; Supabase default grants had
  -- already handed this out-of-band table more than 072 listed. Each verb is asserted on its own
  -- row so a failure names the offending privilege instead of collapsing to one boolean.
  (9, 'I. 073 ACL: anon', 'SELECT',   has_table_privilege('anon','public.credit_transactions','SELECT')::text, 'false'),
  (9, 'I. 073 ACL: anon', 'INSERT',   has_table_privilege('anon','public.credit_transactions','INSERT')::text, 'false'),
  (9, 'I. 073 ACL: anon', 'UPDATE',   has_table_privilege('anon','public.credit_transactions','UPDATE')::text, 'false'),
  (9, 'I. 073 ACL: anon', 'DELETE',   has_table_privilege('anon','public.credit_transactions','DELETE')::text, 'false'),
  (9, 'I. 073 ACL: anon', 'TRUNCATE', has_table_privilege('anon','public.credit_transactions','TRUNCATE')::text, 'false'),

  (10, 'J. 073 ACL: authenticated', 'SELECT (a member may read their own history)',
       has_table_privilege('authenticated','public.credit_transactions','SELECT')::text, 'true'),
  (10, 'J. 073 ACL: authenticated', 'INSERT',   has_table_privilege('authenticated','public.credit_transactions','INSERT')::text, 'false'),
  (10, 'J. 073 ACL: authenticated', 'UPDATE',   has_table_privilege('authenticated','public.credit_transactions','UPDATE')::text, 'false'),
  (10, 'J. 073 ACL: authenticated', 'DELETE',   has_table_privilege('authenticated','public.credit_transactions','DELETE')::text, 'false'),
  (10, 'J. 073 ACL: authenticated', 'TRUNCATE', has_table_privilege('authenticated','public.credit_transactions','TRUNCATE')::text, 'false'),

  (11, 'K. 073 ACL: service_role', 'SELECT',   has_table_privilege('service_role','public.credit_transactions','SELECT')::text, 'true'),
  (11, 'K. 073 ACL: service_role', 'INSERT',   has_table_privilege('service_role','public.credit_transactions','INSERT')::text, 'true'),
  (11, 'K. 073 ACL: service_role', 'UPDATE (append-only: must be denied)',
       has_table_privilege('service_role','public.credit_transactions','UPDATE')::text, 'false'),
  (11, 'K. 073 ACL: service_role', 'DELETE (append-only: must be denied)',
       has_table_privilege('service_role','public.credit_transactions','DELETE')::text, 'false'),
  (11, 'K. 073 ACL: service_role', 'TRUNCATE (append-only: must be denied)',
       has_table_privilege('service_role','public.credit_transactions','TRUNCATE')::text, 'false'),

  -- PUBLIC must hold nothing DIRECTLY. Checked against the grant table rather than
  -- has_table_privilege, which resolves inherited grants and would mask a direct one.
  (12, 'L. PUBLIC holds nothing directly', 'direct grants to PUBLIC in the ACL',
       (SELECT count(*)::text FROM information_schema.role_table_grants
        WHERE table_schema='public' AND table_name='credit_transactions' AND grantee='PUBLIC'), '0'),

  (13, 'M. context', 'ledgered (event-keyed) rows',
      (SELECT count(*)::text FROM public.credit_transactions WHERE event_key IS NOT NULL), 'context'),
  (13, 'M. context', 'legacy (unkeyed) rows, still mutable by design',
      (SELECT count(*)::text FROM public.credit_transactions WHERE event_key IS NULL), 'context'),
  (13, 'M. context', 'match_debit events',
      (SELECT count(*)::text FROM public.credit_transactions WHERE source_kind='match_debit'), 'context'),
  (13, 'M. context', 'match_exempt_admin events',
      (SELECT count(*)::text FROM public.credit_transactions WHERE source_kind='match_exempt_admin'), 'context')
)
SELECT section, check_name, observed, expected,
       CASE WHEN expected='context' THEN 'INFO'
            WHEN observed=expected  THEN 'OK'
            ELSE 'FAIL' END AS verdict
FROM rows_out ORDER BY sort, check_name;
