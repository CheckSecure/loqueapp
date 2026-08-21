-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- PREFLIGHT FOR MIGRATIONS 069 → 070
--
-- STRICTLY READ-ONLY. One statement. SELECT and CTEs only. No DML, no DDL, no locks, no temporary
-- tables, no dynamic SQL, no mutating or VOLATILE calls, no SET. Safe against production any time.
--
-- EMITS NO MEMBER IDENTIFIERS. Every cell is a boolean, a count, an object name, a type name or a
-- status label. No user ids, emails, names, card ids, match ids or conversation ids.
--
-- verdict: OK = nothing to do · BLOCKER = do not apply · REVIEW = a human must look · INFO = context
--
-- Apply order is 069 THEN 070. 069 widens the reminder_deliveries purpose vocabulary and adds the
-- event key; 070 adds the outbox table and its trigger. 070 does not depend on 069's DDL, but the
-- worker that drains the outbox writes rows with purpose 'new_introductions', so 069 must land
-- first or the first drain would be rejected by the old CHECK.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

WITH
rd AS (SELECT to_regclass('public.reminder_deliveries') AS oid),
ir AS (SELECT to_regclass('public.intro_requests')      AS oid),

-- ── A. WHAT 069/070 CREATE MUST NOT ALREADY EXIST ──────────────────────────────────────────────
-- A pre-existing object here means something was created out of band, which is how the delegate
-- incident began. 070 uses IF NOT EXISTS, so a collision is not fatal, but it must be understood.
a AS (
  SELECT 1 AS sort, 'A. new objects must be absent' AS section, nm AS check_name,
         CASE WHEN present THEN 'PRESENT' ELSE 'absent' END AS observed,
         'absent' AS expected,
         CASE WHEN present THEN 'REVIEW' ELSE 'OK' END AS verdict
  FROM (VALUES
    ('table  introduction_email_outbox',  to_regclass('public.introduction_email_outbox') IS NOT NULL),
    ('index  introduction_email_outbox_card_uniq',        to_regclass('public.introduction_email_outbox_card_uniq') IS NOT NULL),
    ('index  introduction_email_outbox_pending_idx',      to_regclass('public.introduction_email_outbox_pending_idx') IS NOT NULL),
    ('index  introduction_email_outbox_stale_claim_idx',  to_regclass('public.introduction_email_outbox_stale_claim_idx') IS NOT NULL),
    ('index  introduction_email_outbox_member_idx',       to_regclass('public.introduction_email_outbox_member_idx') IS NOT NULL),
    ('type   introduction_email_outbox (name collision)',
       EXISTS (SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
               WHERE n.nspname = 'public' AND t.typname = 'introduction_email_outbox')),
    ('func   tg_intro_request_visible_outbox',
       EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'tg_intro_request_visible_outbox')),
    ('column reminder_deliveries.event_key',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='reminder_deliveries' AND column_name='event_key')),
    ('index  reminder_deliveries_event_claim_uniq', to_regclass('public.reminder_deliveries_event_claim_uniq') IS NOT NULL),
    ('index  reminder_deliveries_purpose_status_idx', to_regclass('public.reminder_deliveries_purpose_status_idx') IS NOT NULL)
  ) v(nm, present)
),

-- ── B. intro_requests HAS NO EQUIVALENT OUTBOX TRIGGER ALREADY ─────────────────────────────────
-- 070 drops its own trigger by name before creating it, but a DIFFERENTLY named trigger doing the
-- same job would double-enqueue and is a hard blocker.
b AS (
  SELECT 2, 'B. no conflicting trigger', nm, observed, expected,
         CASE WHEN observed = expected THEN 'OK' ELSE 'BLOCKER' END
  FROM (
    SELECT 'triggers on intro_requests writing an outbox-like table' AS nm,
           COALESCE((SELECT count(*)::text FROM pg_catalog.pg_trigger tg
                     JOIN pg_catalog.pg_proc p ON p.oid = tg.tgfoid
                     WHERE tg.tgrelid = (SELECT oid FROM ir) AND NOT tg.tgisinternal
                       AND pg_catalog.pg_get_functiondef(p.oid) ILIKE '%outbox%'), '0') AS observed,
           '0' AS expected
    UNION ALL SELECT 'a trigger named intro_requests_visible_outbox_aiu already exists',
           (EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
                    WHERE tgrelid = (SELECT oid FROM ir) AND tgname = 'intro_requests_visible_outbox_aiu'))::text,
           'false'
  ) v
),
-- Context only: other user triggers on the table are not a problem, but you should know they exist.
b2 AS (
  SELECT 2, 'B. no conflicting trigger', 'other user triggers on intro_requests (context)',
         COALESCE((SELECT count(*)::text FROM pg_catalog.pg_trigger
                   WHERE tgrelid = (SELECT oid FROM ir) AND NOT tgisinternal), '0'),
         'context', 'INFO'
),

-- ── C. reminder_deliveries IS THE APPLIED 065 SHAPE, AND SUPPORTS 069 ──────────────────────────
-- 069 does DROP CONSTRAINT reminder_deliveries_purpose_check / ADD CONSTRAINT, and DROP INDEX
-- reminder_deliveries_active_claim_uniq / CREATE. Both must exist under EXACTLY those names, or the
-- migration silently leaves the old rule in place and the new purposes are still rejected.
c AS (
  SELECT 3, 'C. 065 shape supports 069', nm, observed, expected,
         CASE WHEN observed = expected THEN 'OK' ELSE 'BLOCKER' END
  FROM (
    SELECT 'reminder_deliveries exists' AS nm,
           ((SELECT oid FROM rd) IS NOT NULL)::text AS observed, 'true' AS expected
    UNION ALL SELECT 'constraint reminder_deliveries_purpose_check exists (069 replaces it by name)',
           (EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                    WHERE conname = 'reminder_deliveries_purpose_check' AND conrelid = (SELECT oid FROM rd)))::text, 'true'
    UNION ALL SELECT 'current purpose CHECK accepts wednesday_intro_reminder',
           COALESCE((SELECT (pg_catalog.pg_get_constraintdef(oid) LIKE '%wednesday_intro_reminder%')::text
                     FROM pg_catalog.pg_constraint
                     WHERE conname = 'reminder_deliveries_purpose_check' AND conrelid = (SELECT oid FROM rd)), 'ABSENT'), 'true'
    UNION ALL SELECT 'index reminder_deliveries_active_claim_uniq exists (069 recreates it by name)',
           (to_regclass('public.reminder_deliveries_active_claim_uniq') IS NOT NULL)::text, 'true'
  ) v
),
-- Required columns for 069's ALTERs and for the worker's writes.
c2 AS (
  SELECT 4, 'C. required columns', t || '.' || col,
         COALESCE(x.data_type, 'MISSING'), 'present',
         CASE WHEN x.column_name IS NULL THEN 'BLOCKER' ELSE 'OK' END
  FROM (VALUES
    ('reminder_deliveries','member_id'), ('reminder_deliveries','purpose'),
    ('reminder_deliveries','cycle_key'), ('reminder_deliveries','status'),
    ('reminder_deliveries','open_card_count'), ('reminder_deliveries','claimed_at'),
    ('reminder_deliveries','provider_message_id'), ('reminder_deliveries','accepted_at'),
    ('reminder_deliveries','error_class'), ('reminder_deliveries','attempts'),
    ('reminder_deliveries','updated_at'),
    ('intro_requests','id'), ('intro_requests','requester_id'), ('intro_requests','target_user_id'),
    ('intro_requests','status'), ('intro_requests','created_at'), ('intro_requests','updated_at'),
    ('profiles','id')
  ) r(t, col)
  LEFT JOIN information_schema.columns x
    ON x.table_schema = 'public' AND x.table_name = r.t AND x.column_name = r.col
),

-- ── D. EXISTING ROWS MUST SATISFY WHAT 069 ADDS ────────────────────────────────────────────────
-- ADD CONSTRAINT validates immediately, and a unique index is rebuilt against live rows. If either
-- would fail, the migration aborts (safely) — better to know now.
d AS (
  SELECT 5, 'D. existing rows satisfy 069', nm, observed, expected,
         CASE WHEN observed = expected THEN 'OK' ELSE 'BLOCKER' END
  FROM (
    SELECT 'rows whose purpose is outside the NEW vocabulary' AS nm,
           COALESCE((SELECT count(*)::text FROM public.reminder_deliveries
                     WHERE purpose NOT IN ('wednesday_intro_reminder','catchup_unanswered_2026_08_20','new_introductions')), '0') AS observed,
           '0' AS expected
    -- after ADD COLUMN every existing event_key is NULL, so any row already carrying the
    -- new_introductions purpose would violate the event-key shape CHECK.
    UNION ALL SELECT 'rows already using purpose new_introductions (would violate the shape CHECK)',
           COALESCE((SELECT count(*)::text FROM public.reminder_deliveries WHERE purpose = 'new_introductions'), '0'), '0'
    -- the recreated claim index is narrower (event_key IS NULL), so it can only be satisfied if the
    -- current one is; this confirms there is no duplicate that would block the rebuild.
    UNION ALL SELECT 'duplicate active claims on (member, purpose, cycle_key)',
           COALESCE((SELECT count(*)::text FROM (
              SELECT member_id, purpose, cycle_key FROM public.reminder_deliveries
              WHERE status IN ('claimed','accepted','delivered','deferred')
              GROUP BY 1,2,3 HAVING count(*) > 1) z), '0'), '0'
  ) v
),

-- ── E. NOTHING WOULD BE DROPPED UNEXPECTEDLY ───────────────────────────────────────────────────
-- 069 drops one constraint and one index, both by name and both immediately recreated. Anything
-- ELSE depending on reminder_deliveries (a view, a rule, another constraint) is worth a look first.
e AS (
  SELECT 6, 'E. dependencies', nm, observed, 'context', 'INFO'
  FROM (
    SELECT 'views/rules depending on reminder_deliveries' AS nm,
           COALESCE((SELECT count(*)::text FROM pg_catalog.pg_depend dp
                     WHERE dp.refobjid = (SELECT oid FROM rd) AND dp.deptype = 'n'
                       AND dp.classid = 'pg_catalog.pg_rewrite'::regclass), '0') AS observed
    UNION ALL SELECT 'foreign keys pointing AT reminder_deliveries',
           COALESCE((SELECT count(*)::text FROM pg_catalog.pg_constraint
                     WHERE confrelid = (SELECT oid FROM rd)), '0')
    UNION ALL SELECT 'triggers on reminder_deliveries',
           COALESCE((SELECT count(*)::text FROM pg_catalog.pg_trigger
                     WHERE tgrelid = (SELECT oid FROM rd) AND NOT tgisinternal), '0')
  ) v
),

-- ── F. NOTHING IS BACKFILLED ───────────────────────────────────────────────────────────────────
-- 070 creates the trigger and inserts nothing, so every card that already exists produces no event
-- and no email. These counts are the "before" picture that proves it after the fact.
f AS (
  SELECT 7, 'F. no backfill', nm, observed, 'context', 'INFO'
  FROM (
    SELECT 'visible cards that will NOT be announced (historical)' AS nm,
           COALESCE((SELECT count(*)::text FROM public.intro_requests WHERE status = 'suggested'), '0') AS observed
    UNION ALL SELECT 'reminder_deliveries rows today',
           COALESCE((SELECT count(*)::text FROM public.reminder_deliveries), '0')
    UNION ALL SELECT 'outbox rows today (table should not exist yet)',
           CASE WHEN to_regclass('public.introduction_email_outbox') IS NULL THEN 'table absent' ELSE 'TABLE EXISTS' END
  ) v
),

-- ── G. intro_requests STATUS VOCABULARY IS COMPATIBLE ──────────────────────────────────────────
-- The trigger keys on the literal 'suggested' and on transitions into it. Labels + counts only.
g AS (
  SELECT 8, 'G. intro_requests by status', status, count(*)::text, 'context', 'INFO'
  FROM public.intro_requests GROUP BY status
),
g2 AS (
  SELECT 8, 'G. intro_requests by status', 'CHECK permits ''suggested''',
         COALESCE((SELECT bool_or(pg_catalog.pg_get_constraintdef(oid) LIKE '%''suggested''%')::text
                   FROM pg_catalog.pg_constraint WHERE conrelid = (SELECT oid FROM ir) AND contype = 'c'), 'no CHECK'),
         'true',
         -- REVIEW, not BLOCKER: the trigger tests the literal value and works whether or not a CHECK
         -- constrains the column. A 'false' here means the vocabulary is enforced elsewhere.
         CASE WHEN COALESCE((SELECT bool_or(pg_catalog.pg_get_constraintdef(oid) LIKE '%''suggested''%')
                             FROM pg_catalog.pg_constraint WHERE conrelid = (SELECT oid FROM ir) AND contype = 'c'), false)
              THEN 'OK' ELSE 'REVIEW' END
),

-- ── H. 065–068 GUARANTEES STILL HOLD ───────────────────────────────────────────────────────────
-- Neither 069 nor 070 touches these. If any row here is wrong, STOP: something else changed them,
-- and that is an incident rather than a migration question.
h AS (
  SELECT 9, 'H. 065-068 guarantees intact', nm, observed, expected,
         CASE WHEN observed = expected THEN 'OK' ELSE 'BLOCKER' END
  FROM (
    -- post-068: the raw delegate is executable by NOBODY, service_role included
    SELECT 'delegate: service_role can execute (must stay FALSE after 068)' AS nm,
           COALESCE((SELECT has_function_privilege('service_role', oid, 'EXECUTE')::text
                     FROM pg_catalog.pg_proc
                     WHERE oid = to_regprocedure('public.consume_credits_and_create_match(uuid,uuid,boolean)')), 'ABSENT') AS observed,
           'false' AS expected
    UNION ALL SELECT 'delegate: anon can execute',
           COALESCE((SELECT has_function_privilege('anon', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                     WHERE oid = to_regprocedure('public.consume_credits_and_create_match(uuid,uuid,boolean)')), 'ABSENT'), 'false'
    UNION ALL SELECT 'delegate: authenticated can execute',
           COALESCE((SELECT has_function_privilege('authenticated', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                     WHERE oid = to_regprocedure('public.consume_credits_and_create_match(uuid,uuid,boolean)')), 'ABSENT'), 'false'
    UNION ALL SELECT 'delegate: PUBLIC can execute',
           COALESCE((SELECT has_function_privilege('public', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                     WHERE oid = to_regprocedure('public.consume_credits_and_create_match(uuid,uuid,boolean)')), 'ABSENT'), 'false'
    -- 067 wrapper: service_role only
    UNION ALL SELECT 'wrapper finalize_mutual_match_atomic: service_role can execute',
           COALESCE((SELECT has_function_privilege('service_role', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                     WHERE oid = to_regprocedure('public.finalize_mutual_match_atomic(uuid,uuid,boolean)')), 'ABSENT'), 'true'
    UNION ALL SELECT 'wrapper: anon can execute',
           COALESCE((SELECT has_function_privilege('anon', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                     WHERE oid = to_regprocedure('public.finalize_mutual_match_atomic(uuid,uuid,boolean)')), 'ABSENT'), 'false'
    UNION ALL SELECT 'wrapper: authenticated can execute',
           COALESCE((SELECT has_function_privilege('authenticated', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                     WHERE oid = to_regprocedure('public.finalize_mutual_match_atomic(uuid,uuid,boolean)')), 'ABSENT'), 'false'
    -- 066 expiry RPC: service_role only
    UNION ALL SELECT 'expire_intro_pair: service_role can execute',
           COALESCE((SELECT has_function_privilege('service_role', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                     WHERE oid = to_regprocedure('public.expire_intro_pair(uuid,integer)')), 'ABSENT'), 'true'
    UNION ALL SELECT 'expire_intro_pair: anon can execute',
           COALESCE((SELECT has_function_privilege('anon', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                     WHERE oid = to_regprocedure('public.expire_intro_pair(uuid,integer)')), 'ABSENT'), 'false'
    UNION ALL SELECT 'expire_intro_pair: authenticated can execute',
           COALESCE((SELECT has_function_privilege('authenticated', oid, 'EXECUTE')::text FROM pg_catalog.pg_proc
                     WHERE oid = to_regprocedure('public.expire_intro_pair(uuid,integer)')), 'ABSENT'), 'false'
    -- 065 table posture
    UNION ALL SELECT 'reminder_deliveries: RLS enabled',
           COALESCE((SELECT relrowsecurity::text FROM pg_catalog.pg_class WHERE oid = (SELECT oid FROM rd)), 'ABSENT'), 'true'
    UNION ALL SELECT 'reminder_deliveries: anon holds no table privilege',
           (NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                        WHERE table_schema='public' AND table_name='reminder_deliveries' AND grantee='anon'))::text, 'true'
    UNION ALL SELECT 'reminder_deliveries: authenticated holds no table privilege',
           (NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                        WHERE table_schema='public' AND table_name='reminder_deliveries' AND grantee='authenticated'))::text, 'true'
  ) v
)

SELECT section, check_name, observed, expected, verdict
FROM (
  SELECT * FROM a UNION ALL SELECT * FROM b  UNION ALL SELECT * FROM b2
  UNION ALL SELECT * FROM c UNION ALL SELECT * FROM c2 UNION ALL SELECT * FROM d
  UNION ALL SELECT * FROM e UNION ALL SELECT * FROM f  UNION ALL SELECT * FROM g
  UNION ALL SELECT * FROM g2 UNION ALL SELECT * FROM h
) t(sort, section, check_name, observed, expected, verdict)
ORDER BY sort, check_name;
