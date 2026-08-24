-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 083  ANDREL CONNECTOR — tell the member, exactly once, in the same transaction
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- WHAT CHANGES. set_andrel_connector() now also inserts ONE bell notification when, and only when,
-- a badge genuinely transitions false -> true. Nothing else about the function moves: the admin
-- check, the row lock, the idempotent 'unchanged' path, the removal path, the reason handling and
-- the audit row are exactly what migration 082 installed.
--
-- WHY IN THE WRITER. The obvious alternative is "award, then insert the notification from
-- TypeScript". That has a crash window: the award commits, the process dies, and the member is
-- recognized with no notification — and a retry cannot tell that case apart from a fresh award. Put
-- it in the same transaction and the question disappears. The badge, the audit event and the
-- notification commit together or not at all, so a notification can never exist without its award
-- and an award can never quietly fail to announce itself.
--
-- EXACT-ONCE, USING THE EXISTING CONVENTION. Migration 006 already established the pattern: a
-- partial unique index over (user_id, type, data->>'dedupeKey'). The key here is the
-- member_recognition_events row id — the award EVENT — so identity is the event, not the member and
-- not the day. That also settles re-award: a genuine remove-then-award writes a NEW event with a new
-- id, so it notifies again, which is the correct behaviour for a genuinely new act of recognition.
-- A duplicate call in the already-awarded state never reaches the insert, because the row lock and
-- the 'unchanged' short-circuit above it return first.
--
-- REMOVAL NOTIFIES NOBODY, and never touches a prior notification.
--
-- ─── WHAT THIS MIGRATION DOES NOT DO ──────────────────────────────────────────────────────────
-- No backfill: no notification is created for any existing badge. Nobody is notified during apply.
-- Migrations 063-082 are untouched; 083 replaces exactly one function, and only after pinning the
-- body migration 082 deployed.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. DRIFT GUARD — FAIL CLOSED, PINNED TO THE POST-082 BODY ─────────────────────────────────
-- Exact signature via to_regprocedure (never proname, never LIMIT 1), then identity arguments,
-- result type, md5(prosrc), length(prosrc), SECURITY DEFINER, empty search_path and the full role
-- posture. The baseline is the body migration 082 installs, derived from the applied artifact whose
-- sha256 was verified (cea8712f138a0a6248d0163d74610fe286b81fac1d9ac939c234ca6348ae82db).
--
-- length(prosrc) counts CHARACTERS, not octets; this body contains multi-byte characters.
DO $drift$
DECLARE
  v_oid  oid;
  v_proc pg_catalog.pg_proc%ROWTYPE;
  v_n    integer;
  v_txt  text;
  v_cfg  text;
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role) THEN
      RAISE EXCEPTION '083: role % does not exist; this is not the audited environment.', v_role;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid = 'public.profiles'::pg_catalog.regclass
                    AND attname = 'is_andrel_connector' AND NOT attisdropped) THEN
    RAISE EXCEPTION '083: migration 082 is not applied (profiles.is_andrel_connector absent).';
  END IF;
  IF pg_catalog.to_regclass('public.member_recognition_events') IS NULL THEN
    RAISE EXCEPTION '083: public.member_recognition_events is absent; 082 is not applied.';
  END IF;

  IF pg_catalog.to_regclass('public.notifications') IS NULL THEN
    RAISE EXCEPTION '083: public.notifications is absent.';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['user_id','type','title','body','link','data','created_at'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                    WHERE attrelid = 'public.notifications'::pg_catalog.regclass
                      AND attname = v_role AND NOT attisdropped) THEN
      RAISE EXCEPTION '083: public.notifications has no % column.', v_role;
    END IF;
  END LOOP;
  -- The exact-once guarantee IS this index. Without it, ON CONFLICT DO NOTHING silently degrades
  -- into "insert every time", so its absence is a refusal rather than a warning.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes
                  WHERE schemaname = 'public'
                    AND indexname = 'notifications_user_type_dedupe_key_uniq') THEN
    RAISE EXCEPTION
      '083: notifications_user_type_dedupe_key_uniq (migration 006) is absent. The exact-once '
      'guarantee depends on it; refusing to rely on application-side dedupe alone.';
  END IF;

  -- RLS must actually be on. Without it the grant correction below is the ONLY thing standing
  -- between a browser session and an arbitrary notification, and a REVOKE alone is a weaker
  -- guarantee than a REVOKE plus row security.
  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class
           WHERE oid = 'public.notifications'::pg_catalog.regclass) THEN
    RAISE EXCEPTION '083: row level security is not enabled on public.notifications.';
  END IF;

  -- A policy that lets a browser role INSERT is a deliberate product decision somebody made. This
  -- migration will not silently delete it; it refuses, so the conflict is resolved by a person.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies pol
     WHERE pol.schemaname = 'public' AND pol.tablename = 'notifications'
       AND pol.cmd IN ('INSERT','ALL')
       AND (pol.roles IS NULL
            OR pol.roles::text[] && ARRAY['public','anon','authenticated'])
  ) THEN
    RAISE EXCEPTION
      '083: a browser-applicable INSERT or ALL policy exists on public.notifications. Refusing to '
      'remove it automatically - resolve it deliberately, then re-run.';
  END IF;

  -- MATERIALLY DIFFERENT POSTURE = REFUSE. The correction below is a broad REVOKE ALL followed by
  -- two precise grants. That is safe against the INHERITED posture it was audited for, and unsafe
  -- against a posture somebody configured deliberately. Two signals distinguish them:
  --
  --   (1) a COLUMN-level grant to a browser role on any column other than read_at. Nothing in this
  --       codebase creates one, so its presence means a person scoped something on purpose, and a
  --       blanket REVOKE ALL would silently undo their work.
  --   (2) a trigger on public.notifications. 083 inserts inside the award transaction; a trigger
  --       could change what that transaction does, and none was audited.
  FOR v_role IN SELECT unnest(ARRAY['anon','authenticated']) LOOP
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.notifications'::pg_catalog.regclass
         AND a.attnum > 0 AND NOT a.attisdropped
         AND a.attname <> 'read_at'
         AND a.attacl IS NOT NULL
         AND EXISTS (SELECT 1 FROM pg_catalog.unnest(a.attacl) g
                      WHERE pg_catalog.split_part(g::text, '=', 1) = v_role)
    ) THEN
      RAISE EXCEPTION
        '083: % holds a COLUMN-level grant on public.notifications outside read_at. That is a '
        'deliberate configuration this migration was not audited against; refusing to revoke it '
        'broadly.', v_role;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
              WHERE tgrelid = 'public.notifications'::pg_catalog.regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION
      '083: public.notifications carries a trigger. 083 inserts inside the award transaction and no '
      'trigger was audited; refusing to proceed.';
  END IF;

  -- The trusted writers must keep working. Every notification INSERT in the application runs as
  -- service_role (createNotificationSafe, the admin actions, facilitate-intro, the opportunity
  -- notifier, and this function), so losing any of these would break them.
  IF NOT pg_catalog.has_table_privilege('service_role', 'public.notifications', 'INSERT')
     OR NOT pg_catalog.has_table_privilege('service_role', 'public.notifications', 'SELECT')
     OR NOT pg_catalog.has_table_privilege('service_role', 'public.notifications', 'UPDATE') THEN
    RAISE EXCEPTION '083: service_role lacks SELECT/INSERT/UPDATE on public.notifications.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'set_andrel_connector'
               -- NOT 'andrel_connector_awarded': the 082 body already contains that as a SUBSTRING
               -- of the column names andrel_connector_awarded_at / _by, so this guard would have
               -- refused a fresh, un-applied database. The unambiguous marker is the insert target.
               AND pg_catalog.strpos(p.prosrc, 'INSERT INTO public.notifications') > 0) THEN
    RAISE EXCEPTION '083: set_andrel_connector already notifies; 083 appears to be applied.';
  END IF;

  v_oid := pg_catalog.to_regprocedure('public.set_andrel_connector(uuid, uuid, boolean, text)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION '083: public.set_andrel_connector(uuid, uuid, boolean, text) is not deployed.';
  END IF;
  SELECT count(*) INTO v_n
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'set_andrel_connector';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '083: set_andrel_connector has % signatures deployed; exactly 1 expected.', v_n;
  END IF;

  SELECT * INTO v_proc FROM pg_catalog.pg_proc WHERE oid = v_oid;

  v_txt := pg_catalog.pg_get_function_identity_arguments(v_oid);
  IF v_txt <> 'p_member_id uuid, p_admin_id uuid, p_enabled boolean, p_reason text' THEN
    RAISE EXCEPTION '083: identity arguments differ. deployed [%]', v_txt;
  END IF;
  v_txt := pg_catalog.pg_get_function_result(v_oid);
  IF v_txt <> 'jsonb' THEN
    RAISE EXCEPTION '083: result type is % but jsonb was audited.', v_txt;
  END IF;
  IF pg_catalog.md5(v_proc.prosrc) <> '2509f15ab6b2a976355fb4329bec1704' THEN
    RAISE EXCEPTION '083: set_andrel_connector body md5 is % but the audited post-082 body is %.',
      pg_catalog.md5(v_proc.prosrc), '2509f15ab6b2a976355fb4329bec1704';
  END IF;
  IF pg_catalog.length(v_proc.prosrc) <> 3277 THEN
    RAISE EXCEPTION '083: body length(prosrc) is % but 3277 was audited (characters).',
      pg_catalog.length(v_proc.prosrc);
  END IF;
  IF NOT v_proc.prosecdef THEN
    RAISE EXCEPTION '083: set_andrel_connector is no longer SECURITY DEFINER.';
  END IF;
  v_cfg := pg_catalog.array_to_string(v_proc.proconfig, ',');
  IF v_proc.proconfig IS NULL OR v_cfg NOT IN ('search_path=', 'search_path=""') THEN
    RAISE EXCEPTION '083: set_andrel_connector search_path is not empty (config: %).',
      COALESCE(v_cfg, '(NONE)');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.unnest(COALESCE(v_proc.proacl, ARRAY[]::pg_catalog.aclitem[])) a
              WHERE a::text LIKE '=%') THEN
    RAISE EXCEPTION '083: set_andrel_connector is EXECUTABLE BY PUBLIC.';
  END IF;
  IF pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION '083: a browser role can execute set_andrel_connector.';
  END IF;
  IF NOT pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION '083: service_role cannot execute set_andrel_connector.';
  END IF;
END;
$drift$;

-- ── 2. THE WRITER, WITH THE NOTIFICATION ──────────────────────────────────────────────────────
-- The 082 body verbatim, plus the RETURNING that captures the audit event id and the guarded
-- INSERT that announces the award. Nothing else is edited.
CREATE OR REPLACE FUNCTION public.set_andrel_connector(
  p_member_id uuid,
  p_admin_id  uuid,
  p_enabled   boolean,
  p_reason    text DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_now     timestamptz := pg_catalog.now();
  v_current boolean;
  v_reason  text;
  v_event_id uuid;
  v_n       integer;
BEGIN
  IF p_member_id IS NULL OR p_admin_id IS NULL OR p_enabled IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','missing_argument');
  END IF;

  -- THE ADMINISTRATOR CHECK. p_admin_id is server-derived from the authenticated session by the
  -- caller and is re-verified here, so a forged value cannot award anything even if the TypeScript
  -- guard were bypassed. An admin cannot award to themselves either — recognition is for members.
  IF NOT EXISTS (SELECT 1 FROM public.profiles a
                  WHERE a.id = p_admin_id AND a.is_admin IS TRUE) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','forbidden','detail','not_an_administrator');
  END IF;
  IF p_admin_id = p_member_id THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','self_award');
  END IF;

  -- Trim, treat blank as absent, and REFUSE an oversized note rather than silently truncating it —
  -- a truncated internal note is worse than none, because it reads as complete.
  v_reason := NULLIF(pg_catalog.btrim(COALESCE(p_reason, '')), '');
  IF v_reason IS NOT NULL AND pg_catalog.length(v_reason) > 500 THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','reason_too_long');
  END IF;

  -- Lock the member row so two concurrent clicks serialise and cannot both write an audit entry.
  SELECT p.is_andrel_connector INTO v_current
    FROM public.profiles p WHERE p.id = p_member_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','member_not_found');
  END IF;

  -- IDEMPOTENT. Already in the requested state -> no write, and NO audit row. This is what makes a
  -- double submission harmless: the second call changes nothing and records nothing.
  IF v_current = p_enabled THEN
    RETURN pg_catalog.jsonb_build_object('outcome','unchanged','enabled', v_current);
  END IF;

  IF p_enabled THEN
    UPDATE public.profiles
       SET is_andrel_connector = true,
           andrel_connector_awarded_at = v_now,
           andrel_connector_awarded_by = p_admin_id
     WHERE id = p_member_id AND is_andrel_connector = false;
  ELSE
    -- Removal clears the active fields; the history is NOT lost, it moves to the audit table.
    UPDATE public.profiles
       SET is_andrel_connector = false,
           andrel_connector_awarded_at = NULL,
           andrel_connector_awarded_by = NULL
     WHERE id = p_member_id AND is_andrel_connector = true;
  END IF;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    -- Lost a race after the lock was released by a concurrent transaction; write nothing.
    RETURN pg_catalog.jsonb_build_object('outcome','unchanged','detail','raced');
  END IF;

  INSERT INTO public.member_recognition_events (member_id, recognition, action, admin_id, reason)
  VALUES (p_member_id, 'andrel_connector',
          CASE WHEN p_enabled THEN 'awarded' ELSE 'removed' END,
          p_admin_id, v_reason)
  RETURNING id INTO v_event_id;

  -- ── THE MEMBER NOTIFICATION (migration 083) ─────────────────────────────────────────────────
  -- AWARD ONLY. A removal is a quiet administrative correction; telling someone their recognition
  -- was taken away would be unkind and serves no purpose. The historical award notification is left
  -- exactly as it is — never deleted, never rewritten.
  --
  -- IN THIS TRANSACTION, deliberately. The badge, the audit row and the notification commit together
  -- or not at all, so a notification can never exist without the award it announces, and an award can
  -- never silently fail to announce itself. The alternative — award here, notify from TypeScript
  -- afterwards — has a crash window between the two that no retry can close safely.
  --
  -- EXACT-ONCE comes from the existing convention: migration 006's partial unique index over
  -- (user_id, type, data->>'dedupeKey'). The key is v_event_id, the recognition event this
  -- notification announces, so the identity is the AWARD EVENT rather than the member or the day.
  -- ON CONFLICT DO NOTHING makes a concurrent duplicate a no-op rather than an error — and because
  -- the enclosing UPDATE already took the row lock and returned 'unchanged' for a repeat, a second
  -- notification cannot be reached at all in the ordinary path.
  --
  -- title, body, link and type are LITERALS here. Nothing about this row can be influenced by a
  -- browser: the caller supplies only the member, the acting admin and an internal note.
  IF p_enabled THEN
    INSERT INTO public.notifications (user_id, type, title, body, link, data, created_at)
    VALUES (
      p_member_id,
      'andrel_connector_awarded',
      'You''ve been recognized as an Andrel Connector',
      'Thank you for thoughtfully helping grow the Andrel community by inviting engaged professionals.',
      '/dashboard/profile',
      pg_catalog.jsonb_build_object('dedupeKey', v_event_id::text, 'recognition', 'andrel_connector'),
      v_now)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'outcome', CASE WHEN p_enabled THEN 'awarded' ELSE 'removed' END,
    'enabled', p_enabled,
    'awarded_at', CASE WHEN p_enabled THEN v_now ELSE NULL END);
END;
$fn$;

-- Restated because a GRANT is additive: only a REVOKE removes one.
REVOKE ALL ON FUNCTION public.set_andrel_connector(uuid, uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_andrel_connector(uuid, uuid, boolean, text) FROM anon;
REVOKE ALL ON FUNCTION public.set_andrel_connector(uuid, uuid, boolean, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.set_andrel_connector(uuid, uuid, boolean, text) TO service_role;

-- ── 3. NARROW PRIVILEGE CORRECTION ON public.notifications ────────────────────────────────────
-- WHY THIS IS HERE AND NOT IN A SEPARATE MIGRATION. 083 makes the database itself a notification
-- writer, so the question "who else can write notifications" stops being background and becomes
-- part of this change's threat model. The correction is deliberately narrow: it removes privileges
-- that NO caller uses, and grants nothing new.
--
-- WHY THE PRIVILEGES ARE THERE AT ALL. Supabase's ALTER DEFAULT PRIVILEGES grants anon and
-- authenticated ALL on every newly created table. public.notifications predates the migration files,
-- so it very likely arrived holding INSERT, UPDATE and DELETE for both. RLS makes those hard to
-- exploit, but "hard because of a policy" is a weaker guarantee than "absent", and a GRANT is
-- additive: only a REVOKE removes one.
--
-- INVENTORY THAT MAKES THIS SAFE. Every notification INSERT in the application runs as service_role:
-- createNotificationSafe (lib/notifications), five admin actions in app/actions.ts,
-- api/admin/facilitate-intro, lib/opportunities/notifications, sendMessageCore (via
-- createNotificationSafe), and now set_andrel_connector. NOT ONE browser-client insert exists.
-- The bell's only writes are mark-as-read, which touch read_at and nothing else
-- (lib/notifications/bell.ts, components/MarkNetworkNotificationsRead.tsx).
--
-- SO: browser roles keep SELECT, and keep UPDATE — but only of read_at. A member marking a
-- notification read is legitimate; a member rewriting the title, the link, the type or the dedupe
-- key of their own award notification is not. That last one matters here specifically: the dedupe
-- key IS the exact-once guarantee, and a member able to edit it could break the correlation between
-- a notification and the award event it announces.
--
-- service_role is untouched.
-- REVOKE ALL, then grant back exactly the two abilities the bell needs. Revoking the individual
-- verbs would have left column-level grants behind — PostgreSQL treats those separately — and the
-- guard above has already refused any column grant outside read_at, so ALL is both safe and total.
--
-- anon loses SELECT as well. The inventory found no anonymous notification reader: the bell and the
-- notifications page both run on the member's session, and RLS would return zero rows for a NULL
-- auth.uid() anyway. Removing it means a future RLS misconfiguration cannot turn into an anonymous
-- read of every member's notifications.
REVOKE ALL ON public.notifications FROM PUBLIC;
REVOKE ALL ON public.notifications FROM anon;
REVOKE ALL ON public.notifications FROM authenticated;

-- Reads: the bell depends on them, and RLS still scopes them to the member's own rows.
GRANT SELECT ON public.notifications TO authenticated;
-- Writes: mark-as-read, and nothing else. Column-scoped, so a member cannot rewrite the title, the
-- link, the type, the timestamps or data->>'dedupeKey' — that key IS the exact-once guarantee.
GRANT UPDATE (read_at) ON public.notifications TO authenticated;

-- Post-condition, same transaction: if any of this went wrong, roll the whole migration back rather
-- than leave the bell broken or a browser role holding INSERT.
DO $acl$
DECLARE v_role text; v_priv text; v_col text;
BEGIN
  -- PUBLIC and anon must hold NOTHING, at table level or on any column.
  FOREACH v_priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
    IF pg_catalog.has_table_privilege('anon', 'public.notifications', v_priv) THEN
      RAISE EXCEPTION '083: anon still holds % on public.notifications.', v_priv;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
                    pg_catalog.unnest(COALESCE(c.relacl, ARRAY[]::pg_catalog.aclitem[])) a
              WHERE c.oid = 'public.notifications'::pg_catalog.regclass
                AND a::text LIKE '=%') THEN
    RAISE EXCEPTION '083: PUBLIC still holds a privilege on public.notifications.';
  END IF;

  -- authenticated: SELECT, plus UPDATE on read_at, and nothing else — checked COLUMN BY COLUMN so a
  -- stray grant on any other column cannot hide behind a table-level check.
  IF NOT pg_catalog.has_table_privilege('authenticated', 'public.notifications', 'SELECT') THEN
    RAISE EXCEPTION '083: authenticated lost SELECT - the bell would stop rendering.';
  END IF;
  IF NOT pg_catalog.has_column_privilege('authenticated', 'public.notifications', 'read_at', 'UPDATE') THEN
    RAISE EXCEPTION '083: authenticated lost UPDATE(read_at) - mark-as-read would stop working.';
  END IF;
  FOREACH v_priv IN ARRAY ARRAY['INSERT','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
    IF pg_catalog.has_table_privilege('authenticated', 'public.notifications', v_priv) THEN
      RAISE EXCEPTION '083: authenticated still holds % on public.notifications.', v_priv;
    END IF;
  END LOOP;
  FOR v_col IN SELECT a.attname FROM pg_catalog.pg_attribute a
                WHERE a.attrelid = 'public.notifications'::pg_catalog.regclass
                  AND a.attnum > 0 AND NOT a.attisdropped LOOP
    IF v_col <> 'read_at'
       AND pg_catalog.has_column_privilege('authenticated', 'public.notifications', v_col, 'UPDATE') THEN
      RAISE EXCEPTION '083: authenticated can still UPDATE column %.', v_col;
    END IF;
    IF pg_catalog.has_column_privilege('authenticated', 'public.notifications', v_col, 'INSERT') THEN
      RAISE EXCEPTION '083: authenticated can still INSERT column %.', v_col;
    END IF;
  END LOOP;

  -- service_role keeps exactly what the active writers need.
  FOREACH v_priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE'] LOOP
    IF NOT pg_catalog.has_table_privilege('service_role', 'public.notifications', v_priv) THEN
      RAISE EXCEPTION '083: service_role lost % - the trusted writers need it.', v_priv;
    END IF;
  END LOOP;

  -- The member policies must be untouched: 083 changes grants, never row security.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies
                  WHERE schemaname='public' AND tablename='notifications' AND cmd='SELECT') THEN
    RAISE EXCEPTION '083: the member SELECT policy is missing.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies
                  WHERE schemaname='public' AND tablename='notifications' AND cmd='UPDATE') THEN
    RAISE EXCEPTION '083: the member UPDATE policy is missing.';
  END IF;
END;
$acl$;

COMMENT ON FUNCTION public.set_andrel_connector(uuid, uuid, boolean, text) IS
  'THE only writer of the Andrel Connector recognition. Verifies the acting administrator, locks the '
  'member row, keeps the three profile columns consistent, appends exactly one audit event, and on a '
  'genuine false->true transition inserts exactly one bell notification keyed to that audit event - '
  'all in one transaction. Idempotent: a repeat call in the same state writes nothing at all. '
  'Removal notifies nobody and never touches a prior notification. service_role only.';

COMMIT;
