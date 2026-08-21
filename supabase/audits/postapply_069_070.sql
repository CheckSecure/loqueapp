-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION FOR MIGRATIONS 069 + 070
--
-- Run AFTER both migrations are applied, BEFORE deploying the application that drains the outbox.
--
-- STRICTLY READ-ONLY. One statement, SELECT and CTEs only. No DML, DDL, locks, temporary tables,
-- dynamic SQL or mutating calls. Emits no member identifiers — booleans, counts and object names.
--
-- Every row must read OK. A FAIL means the migration did not land as reviewed; do not deploy.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

WITH
rd  AS (SELECT to_regclass('public.reminder_deliveries')       AS oid),
ob  AS (SELECT to_regclass('public.introduction_email_outbox') AS oid),
ir  AS (SELECT to_regclass('public.intro_requests')            AS oid),
tgf AS (SELECT p.oid, p.prosecdef, p.proconfig, p.prosrc
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'tg_intro_request_visible_outbox'),
tg  AS (SELECT tgname, tgenabled, tgtype, tgattr
        FROM pg_catalog.pg_trigger
        WHERE tgrelid = (SELECT oid FROM ir) AND tgname = 'intro_requests_visible_outbox_aiu'),
pchk AS (SELECT pg_catalog.pg_get_constraintdef(oid) AS def
         FROM pg_catalog.pg_constraint
         WHERE conname = 'reminder_deliveries_purpose_check' AND conrelid = (SELECT oid FROM rd)),
-- Comment-stripped trigger body, so a reference inside a comment cannot pass the qualification test.
src AS (SELECT regexp_replace(COALESCE((SELECT prosrc FROM tgf), ''), '--[^\n]*', '', 'g') AS s),

rows_out(sort, section, check_name, observed, expected) AS (VALUES

  -- ── 069: purposes ────────────────────────────────────────────────────────────────────────────
  (1, '069 purposes', 'CHECK accepts wednesday_intro_reminder (the LIVE one)',
      COALESCE((SELECT (def LIKE '%wednesday_intro_reminder%')::text FROM pchk), 'ABSENT'), 'true'),
  (1, '069 purposes', 'CHECK accepts catchup_unanswered_2026_08_20',
      COALESCE((SELECT (def LIKE '%catchup_unanswered_2026_08_20%')::text FROM pchk), 'ABSENT'), 'true'),
  (1, '069 purposes', 'CHECK accepts new_introductions',
      COALESCE((SELECT (def LIKE '%new_introductions%')::text FROM pchk), 'ABSENT'), 'true'),
  (1, '069 purposes', 'purpose CHECK is validated',
      COALESCE((SELECT convalidated::text FROM pg_catalog.pg_constraint
                WHERE conname = 'reminder_deliveries_purpose_check' AND conrelid = (SELECT oid FROM rd)), 'ABSENT'), 'true'),

  -- ── 069: event_key ───────────────────────────────────────────────────────────────────────────
  (2, '069 event_key', 'column exists and is nullable',
      COALESCE((SELECT (data_type = 'text' AND is_nullable = 'YES')::text FROM information_schema.columns
                WHERE table_schema='public' AND table_name='reminder_deliveries' AND column_name='event_key'), 'MISSING'), 'true'),
  (2, '069 event_key', 'shape CHECK ties event_key to purpose new_introductions',
      COALESCE((SELECT convalidated::text FROM pg_catalog.pg_constraint
                WHERE conname = 'reminder_deliveries_event_key_shape_chk' AND conrelid = (SELECT oid FROM rd)), 'ABSENT'), 'true'),
  (2, '069 event_key', 'week claim index now EXCLUDES event-keyed rows',
      COALESCE((SELECT (indexdef LIKE '%event_key IS NULL%')::text FROM pg_indexes
                WHERE schemaname='public' AND indexname='reminder_deliveries_active_claim_uniq'), 'ABSENT'), 'true'),
  (2, '069 event_key', 'event claim index exists and is UNIQUE',
      COALESCE((SELECT (indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '%event_key IS NOT NULL%')::text
                FROM pg_indexes WHERE schemaname='public' AND indexname='reminder_deliveries_event_claim_uniq'), 'ABSENT'), 'true'),
  (2, '069 event_key', 'purpose/status lookup index exists',
      (to_regclass('public.reminder_deliveries_purpose_status_idx') IS NOT NULL)::text, 'true'),
  (2, '069 event_key', 'no existing row was given an event_key',
      COALESCE((SELECT count(*)::text FROM public.reminder_deliveries WHERE event_key IS NOT NULL), '0'), '0'),

  -- ── 070: the outbox table ────────────────────────────────────────────────────────────────────
  (3, '070 outbox table', 'table exists',
      ((SELECT oid FROM ob) IS NOT NULL)::text, 'true'),
  (3, '070 outbox table', 'is EMPTY — no historical backfill occurred',
      COALESCE((SELECT count(*)::text FROM public.introduction_email_outbox), 'ABSENT'), '0'),
  (3, '070 outbox table', 'RLS enabled',
      COALESCE((SELECT relrowsecurity::text FROM pg_catalog.pg_class WHERE oid = (SELECT oid FROM ob)), 'ABSENT'), 'true'),
  (3, '070 outbox table', 'ZERO policies',
      COALESCE((SELECT count(*)::text FROM pg_catalog.pg_policy WHERE polrelid = (SELECT oid FROM ob)), 'ABSENT'), '0'),
  (3, '070 outbox table', 'anon holds no privilege',
      (NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                   WHERE table_schema='public' AND table_name='introduction_email_outbox' AND grantee='anon'))::text, 'true'),
  (3, '070 outbox table', 'authenticated holds no privilege',
      (NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                   WHERE table_schema='public' AND table_name='introduction_email_outbox' AND grantee='authenticated'))::text, 'true'),
  (3, '070 outbox table', 'PUBLIC holds no privilege',
      (NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                   WHERE table_schema='public' AND table_name='introduction_email_outbox' AND grantee='PUBLIC'))::text, 'true'),
  -- Each verb on its OWN row. A combined AND would report a single 'false' and leave the operator
  -- guessing which privilege is wrong. This is also the check that missed the real defect: a plain
  -- local cluster has no Supabase default privileges, so the table was created there WITHOUT the
  -- inherited DELETE grant and a coarse check still passed. Migration 071 corrects the grant; these
  -- four rows are what prove it, in production, one verb at a time.
  (3, '070 outbox table', 'service_role privilege: SELECT',
      has_table_privilege('service_role','public.introduction_email_outbox','SELECT')::text, 'true'),
  (3, '070 outbox table', 'service_role privilege: INSERT',
      has_table_privilege('service_role','public.introduction_email_outbox','INSERT')::text, 'true'),
  (3, '070 outbox table', 'service_role privilege: UPDATE',
      has_table_privilege('service_role','public.introduction_email_outbox','UPDATE')::text, 'true'),
  -- DELETE must be FALSE. The outbox is the durable record that an email is owed; a role that could
  -- delete an event could erase that obligation, which is the exact failure the outbox prevents.
  (3, '070 outbox table', 'service_role privilege: DELETE (must be denied)',
      has_table_privilege('service_role','public.introduction_email_outbox','DELETE')::text, 'false'),
  (3, '070 outbox table', 'service_role privilege: TRUNCATE (must be denied)',
      has_table_privilege('service_role','public.introduction_email_outbox','TRUNCATE')::text, 'false'),
  (3, '070 outbox table', 'stores no message content column',
      (NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name='introduction_email_outbox'
                     AND column_name IN ('email','full_name','first_name','subject','html','body','provider_payload')))::text, 'true'),

  -- ── 070: integrity constraints ───────────────────────────────────────────────────────────────
  (4, '070 constraints', 'claim shape CHECK exists and is validated',
      COALESCE((SELECT convalidated::text FROM pg_catalog.pg_constraint
                WHERE conname='introduction_email_outbox_claim_shape_chk' AND conrelid=(SELECT oid FROM ob)), 'ABSENT'), 'true'),
  (4, '070 constraints', 'lease order CHECK exists and is validated',
      COALESCE((SELECT convalidated::text FROM pg_catalog.pg_constraint
                WHERE conname='introduction_email_outbox_lease_order_chk' AND conrelid=(SELECT oid FROM ob)), 'ABSENT'), 'true'),
  (4, '070 constraints', 'processed shape CHECK exists and is validated',
      COALESCE((SELECT convalidated::text FROM pg_catalog.pg_constraint
                WHERE conname='introduction_email_outbox_processed_shape_chk' AND conrelid=(SELECT oid FROM ob)), 'ABSENT'), 'true'),
  (4, '070 constraints', 'one event per card: UNIQUE on intro_request_id',
      COALESCE((SELECT (indexdef LIKE 'CREATE UNIQUE INDEX%')::text FROM pg_indexes
                WHERE schemaname='public' AND indexname='introduction_email_outbox_card_uniq'), 'ABSENT'), 'true'),
  (4, '070 constraints', 'pending-selection index is partial on status=pending',
      COALESCE((SELECT (indexdef LIKE '%status = ''pending''%')::text FROM pg_indexes
                WHERE schemaname='public' AND indexname='introduction_email_outbox_pending_idx'), 'ABSENT'), 'true'),
  (4, '070 constraints', 'stale-claim index is partial on status=claimed over the lease',
      COALESCE((SELECT (indexdef LIKE '%claim_expires_at%' AND indexdef LIKE '%status = ''claimed''%')::text
                FROM pg_indexes WHERE schemaname='public' AND indexname='introduction_email_outbox_stale_claim_idx'), 'ABSENT'), 'true'),
  (4, '070 constraints', 'member lookup index exists',
      (to_regclass('public.introduction_email_outbox_member_idx') IS NOT NULL)::text, 'true'),
  (4, '070 constraints', 'FK to intro_requests cascades on delete',
      COALESCE((SELECT (confdeltype = 'c')::text FROM pg_catalog.pg_constraint
                WHERE conrelid=(SELECT oid FROM ob) AND contype='f'
                  AND confrelid=(SELECT oid FROM ir)), 'ABSENT'), 'true'),

  -- ── 070: the trigger ─────────────────────────────────────────────────────────────────────────
  (5, '070 trigger', 'exists on intro_requests',
      ((SELECT count(*) FROM tg) = 1)::text, 'true'),
  (5, '070 trigger', 'is ENABLED (origin)',
      COALESCE((SELECT tgenabled::text FROM tg), 'ABSENT'), 'O'),
  (5, '070 trigger', 'fires AFTER, not BEFORE',
      COALESCE((SELECT ((tgtype & 2) = 0)::text FROM tg), 'ABSENT'), 'true'),
  (5, '070 trigger', 'fires FOR EACH ROW',
      COALESCE((SELECT ((tgtype & 1) = 1)::text FROM tg), 'ABSENT'), 'true'),
  (5, '070 trigger', 'covers INSERT',
      COALESCE((SELECT ((tgtype & 4) = 4)::text FROM tg), 'ABSENT'), 'true'),
  (5, '070 trigger', 'covers UPDATE (the queued -> suggested transition)',
      COALESCE((SELECT ((tgtype & 16) = 16)::text FROM tg), 'ABSENT'), 'true'),
  (5, '070 trigger', 'does NOT fire on DELETE',
      COALESCE((SELECT ((tgtype & 8) = 0)::text FROM tg), 'ABSENT'), 'true'),
  (5, '070 trigger', 'UPDATE is narrowed to the status column only',
      COALESCE((SELECT (tgattr::text = (SELECT attnum::text FROM pg_catalog.pg_attribute
                                        WHERE attrelid=(SELECT oid FROM ir) AND attname='status'))::text FROM tg), 'ABSENT'), 'true'),

  -- ── 070: trigger function hardening and logic ────────────────────────────────────────────────
  (6, '070 trigger fn', 'SECURITY DEFINER',
      COALESCE((SELECT prosecdef::text FROM tgf), 'ABSENT'), 'true'),
  (6, '070 trigger fn', 'search_path is empty',
      COALESCE((SELECT array_to_string(proconfig, ',') FROM tgf), 'ABSENT'), 'search_path=""'),
  (6, '070 trigger fn', 'anon cannot execute',
      COALESCE((SELECT has_function_privilege('anon', oid, 'EXECUTE')::text FROM tgf), 'ABSENT'), 'false'),
  (6, '070 trigger fn', 'authenticated cannot execute',
      COALESCE((SELECT has_function_privilege('authenticated', oid, 'EXECUTE')::text FROM tgf), 'ABSENT'), 'false'),
  (6, '070 trigger fn', 'PUBLIC cannot execute',
      COALESCE((SELECT has_function_privilege('public', oid, 'EXECUTE')::text FROM tgf), 'ABSENT'), 'false'),
  (6, '070 trigger fn', 'every reference is schema-qualified',
      (regexp_replace((SELECT s FROM src), 'public\.(introduction_email_outbox|intro_requests)', '', 'g')
         ~ '\m(introduction_email_outbox|intro_requests)\M')::text, 'false'),
  (6, '070 trigger fn', 'enqueues a row born visible (INSERT suggested)',
      ((SELECT s FROM src) ~ 'TG_OP = ''INSERT''')::text, 'true'),
  (6, '070 trigger fn', 'enqueues only a TRANSITION into visible, never suggested -> suggested',
      ((SELECT s FROM src) ~ 'OLD\.status IS DISTINCT FROM ''suggested''')::text, 'true'),
  (6, '070 trigger fn', 'is idempotent per card (ON CONFLICT DO NOTHING)',
      ((SELECT s FROM src) ~ 'ON CONFLICT \(intro_request_id\) DO NOTHING')::text, 'true'),

  -- ── 065–068 GUARANTEES UNCHANGED ─────────────────────────────────────────────────────────────
  (7, '065-068 unchanged', 'delegate: service_role still CANNOT execute (post-068)',
      COALESCE((SELECT has_function_privilege('service_role', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.consume_credits_and_create_match(uuid,uuid,boolean)')), 'ABSENT'), 'false'),
  (7, '065-068 unchanged', 'delegate: anon still cannot execute',
      COALESCE((SELECT has_function_privilege('anon', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.consume_credits_and_create_match(uuid,uuid,boolean)')), 'ABSENT'), 'false'),
  (7, '065-068 unchanged', 'delegate: authenticated still cannot execute',
      COALESCE((SELECT has_function_privilege('authenticated', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.consume_credits_and_create_match(uuid,uuid,boolean)')), 'ABSENT'), 'false'),
  (7, '065-068 unchanged', 'delegate: PUBLIC still cannot execute',
      COALESCE((SELECT has_function_privilege('public', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.consume_credits_and_create_match(uuid,uuid,boolean)')), 'ABSENT'), 'false'),
  (7, '065-068 unchanged', 'wrapper: service_role can execute',
      COALESCE((SELECT has_function_privilege('service_role', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_mutual_match_atomic(uuid,uuid,boolean)')), 'ABSENT'), 'true'),
  (7, '065-068 unchanged', 'wrapper: anon cannot execute',
      COALESCE((SELECT has_function_privilege('anon', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.finalize_mutual_match_atomic(uuid,uuid,boolean)')), 'ABSENT'), 'false'),
  (7, '065-068 unchanged', 'expire_intro_pair: service_role can execute',
      COALESCE((SELECT has_function_privilege('service_role', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.expire_intro_pair(uuid,integer)')), 'ABSENT'), 'true'),
  (7, '065-068 unchanged', 'expire_intro_pair: authenticated cannot execute',
      COALESCE((SELECT has_function_privilege('authenticated', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                WHERE oid = to_regprocedure('public.expire_intro_pair(uuid,integer)')), 'ABSENT'), 'false'),
  (7, '065-068 unchanged', 'reminder_deliveries: RLS still enabled',
      COALESCE((SELECT relrowsecurity::text FROM pg_catalog.pg_class WHERE oid = (SELECT oid FROM rd)), 'ABSENT'), 'true'),
  (7, '065-068 unchanged', 'reminder_deliveries: anon still holds no privilege',
      (NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                   WHERE table_schema='public' AND table_name='reminder_deliveries' AND grantee='anon'))::text, 'true'),

  -- ── CONTEXT ──────────────────────────────────────────────────────────────────────────────────
  (8, 'context', 'visible cards that remain unannounced (catch-up territory)',
      COALESCE((SELECT count(*)::text FROM public.intro_requests WHERE status = 'suggested'), '0'),
      'context'),
  (8, 'context', 'reminder_deliveries rows',
      COALESCE((SELECT count(*)::text FROM public.reminder_deliveries), '0'), 'context')
)

SELECT section, check_name, observed, expected,
       CASE WHEN expected = 'context' THEN 'INFO'
            WHEN observed = expected  THEN 'OK'
            ELSE 'FAIL' END AS verdict
FROM rows_out
ORDER BY sort, check_name;
