-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 075 — PERMANENT ACCOUNT-DELETION LEDGER
--
-- WHY THIS EXISTS. A member disappeared and the database could not say whether they deleted their
-- own account, an admin revoked them, or something else removed them — because no deletion path
-- wrote any durable record. The account's own disappearance erased the only evidence of it.
--
-- PRODUCT DECISION IMPLEMENTED HERE (Daniel, this task):
--   • The hard-deletion outcome for member data and Network relationships is KEPT as-is.
--   • NO member-visible "Former member" tombstone is added.
--   • No profile, email, message or conversation content is preserved anywhere.
--   • The ONLY thing retained is the minimum restricted record proving a deletion occurred and
--     whether it completed.
--
-- ─── RETENTION AND ACCESS PURPOSE ─────────────────────────────────────────────────────────────
-- PURPOSE: security, fraud prevention, compliance, and operational integrity — to answer, for an
--   account that no longer exists, WHEN it was removed, BY WHICH CATEGORY of actor, THROUGH WHICH
--   path, and WHETHER IT COMPLETED. Nothing more.
-- RETENTION PERIOD: SEVEN (7) YEARS from the event timestamp. Chosen to match the longest ordinary
--   commercial record-keeping horizon; no existing Andrel policy or legal requirement specifies a
--   different period. This is NOT indefinite retention and must not be described as such.
--   ENFORCED AUTOMATICALLY by public.purge_expired_account_deletion_events() (PART 4), which the
--   daily engagement-reminders maintenance run calls once per invocation. The period is therefore a
--   mechanism, not merely a commitment. Earlier removal is possible only through a documented
--   legal/privacy process — no arbitrary per-user deletion endpoint exists.
-- WHAT IS NEVER STORED: no plaintext email, no name, no profile field, no message content, no
--   conversation content, no access token, no IP address, no raw provider payload, no raw SQL error,
--   and NO plain unsalted email hash (trivially reversible; never an option). The column list gives
--   these nowhere to live, and the CHECK constraints enforce the shape of what remains.
-- WHAT IS STORED: an immutable event id, a deletion_id, the deleted account's historical UUID
--   (deliberately NOT a foreign key), a timestamp, an actor category, a deletion path, a lifecycle
--   stage, an idempotent event key, safe aggregate integer counts, and a failure CLASS.
-- ON THE UUID: retained because without it the ledger is an unattributable count of deletions and
--   could not answer the question that prompted this work. It is an opaque internal identifier for
--   a row that no longer exists.
-- NO EMAIL FINGERPRINT: no HMAC capability exists in this database (pgcrypto is referenced by no
--   migration), and none is needed — public.invitation_deliveries already retains recipient_email
--   alongside auth_user_id with no FK, so deleted_user_id joins straight to it.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Count-shape validator ─────────────────────────────────────────────────────────────────────
-- A CHECK may not contain a subquery, and validating "every value is a non-negative whole number"
-- requires iterating the object — so the rule lives in an IMMUTABLE function the CHECK calls. This
-- is what makes it structurally impossible to smuggle a name, an email, an error string or a
-- provider payload into object_counts.
CREATE OR REPLACE FUNCTION public.account_deletion_counts_ok(p_counts jsonb)
  RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = ''
AS $fn$
  SELECT p_counts IS NULL
      OR ( jsonb_typeof(p_counts) = 'object'
           AND COALESCE((SELECT bool_and(
                 jsonb_typeof(e.value) = 'number'
                 AND (e.value)::numeric >= 0
                 AND (e.value)::numeric = pg_catalog.trunc((e.value)::numeric))
               FROM jsonb_each(p_counts) AS e), true) );
$fn$;
REVOKE ALL ON FUNCTION public.account_deletion_counts_ok(jsonb) FROM PUBLIC, anon, authenticated;

-- ── The ledger ────────────────────────────────────────────────────────────────────────────────
--
-- APPEND-ONLY EVENT LOG, NOT A MUTABLE STATUS ROW. Each lifecycle transition is its own INSERT
-- sharing a deletion_id. This is what makes "no UPDATE privilege" and "a durable lifecycle"
-- compatible: advancing the state is an insert, never an update, so the append-only guarantee is
-- never relaxed to accommodate progress. Current state = the latest row for a deletion_id.
--
-- NO FOREIGN KEYS, DELIBERATELY. A FK to profiles(id) or auth.users(id) would either block the very
-- deletion it records or cascade the record away with it. The ledger must outlive its subject.
--
-- deletion_id IS THE DELETED ACCOUNT'S UUID. That is not laziness — it is what lets an event
-- written by application code and an event written by a database trigger CONVERGE on one lifecycle
-- instead of producing two unrelated half-records for the same deletion. A completed deletion
-- cannot recur for the same uuid, so uniqueness holds. The one case with no uuid is a bulk TRUNCATE
-- (see below), which mints its own id and records a NULL subject.
CREATE TABLE IF NOT EXISTS public.account_deletion_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deletion_id    uuid NOT NULL,
  event_key      text NOT NULL,

  stage          text NOT NULL CHECK (stage IN (
                    'requested',      -- actor + target captured; nothing destroyed yet
                    'data_deleted',   -- application rows are gone
                    'auth_deleted',   -- the auth identity is gone; deletion is COMPLETE
                    'failed'          -- an out-of-transaction step did not complete
                  )),

  -- 'system' covers both platform-originated and unattributable (out-of-band) deletions.
  actor_category text NOT NULL CHECK (actor_category IN ('self', 'admin', 'system')),

  deletion_path  text NOT NULL CHECK (deletion_path IN (
                    'self_service_rpc',    -- public.delete_user_account()
                    'admin_invite_revoke', -- /api/admin/waitlist/revoke
                    'admin_manage_link',   -- /api/manage-information/delete
                    'out_of_band',         -- dashboard, Auth Admin API, direct SQL, cascade
                    'other'
                  )),

  -- Closed vocabulary. Free text is not permitted: a reason field is where a plaintext email or a
  -- member's own words would eventually be written by someone in a hurry.
  reason_category text NULL CHECK (reason_category IS NULL OR reason_category IN (
                    'member_request', 'invitation_revoked', 'never_onboarded',
                    'policy_enforcement', 'duplicate_account', 'unspecified'
                  )),

  -- The deleted account's historical UUID. NOT a foreign key. NULL only for a bulk TRUNCATE event,
  -- which has no single subject.
  deleted_user_id uuid NULL,

  -- Aggregate counts ONLY, e.g. {"matches": 4}. Every value must be a non-negative whole number.
  object_counts  jsonb NULL,

  -- A CLASSIFICATION, never a message. Raw errors routinely echo the input that caused them.
  error_class    text NULL CHECK (error_class IS NULL OR error_class ~ '^[a-z0-9_]{1,40}$'),

  -- clock_timestamp(), NOT now(). now() is fixed at transaction start, so the three events written
  -- by one atomic deletion would carry an IDENTICAL timestamp and their order would be
  -- unrecoverable. clock_timestamp() advances within the transaction.
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT account_deletion_events_event_key_uniq UNIQUE (event_key),
  CONSTRAINT account_deletion_events_counts_shape
    CHECK (public.account_deletion_counts_ok(object_counts)),
  CONSTRAINT account_deletion_events_error_only_on_failure
    CHECK (error_class IS NULL OR stage = 'failed')
);

CREATE INDEX IF NOT EXISTS account_deletion_events_deletion_id_idx
  ON public.account_deletion_events (deletion_id, occurred_at);
CREATE INDEX IF NOT EXISTS account_deletion_events_user_idx
  ON public.account_deletion_events (deleted_user_id) WHERE deleted_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS account_deletion_events_occurred_idx
  ON public.account_deletion_events (occurred_at DESC);

COMMENT ON TABLE public.account_deletion_events IS
  'Immutable append-only record of account deletions. Written inside the deleting transaction, and '
  'also by BEFORE DELETE triggers on public.profiles and auth.users so deletions originating '
  'outside the application are captured too. No FKs: it must outlive its subject. Contains no '
  'email, name, profile field, message or conversation content, token, IP, provider payload or raw '
  'SQL error. RETENTION: 7 years from occurred_at, purged automatically by '
  'public.purge_expired_account_deletion_events(). See migration 075.';

-- ── Append-only enforcement ───────────────────────────────────────────────────────────────────
-- Privileges alone are NOT sufficient: the table owner, a superuser, and any SECURITY DEFINER
-- function bypass them — which is exactly how a well-meaning privileged application write would
-- corrupt an audit record. A trigger refuses the operation regardless of who is asking.
CREATE OR REPLACE FUNCTION public.tg_account_deletion_events_append_only()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
BEGIN
  -- UPDATE and TRUNCATE are never permitted, by anyone, for any reason. There is no marker, flag or
  -- privilege that unlocks them.
  IF TG_OP <> 'DELETE' THEN
    RAISE EXCEPTION 'account_deletion_events is append-only; % is not permitted', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- DELETE is permitted through EXACTLY ONE door: the retention purge, which sets a
  -- TRANSACTION-LOCAL marker before its DELETE and clears it after. An ordinary query cannot open
  -- that door — service_role holds no DELETE privilege on this table at all, so it cannot issue the
  -- statement in the first place; this check is the second lock, not the only one.
  IF pg_catalog.current_setting('andrel.retention_purge', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION
      'account_deletion_events is append-only; DELETE is permitted only through public.purge_expired_account_deletion_events()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- And even inside the purge, only a genuinely expired row may go. The retention boundary is
  -- enforced HERE as well as in the purge body, so a future edit to the purge cannot widen it: the
  -- table itself refuses to give up a row that is not yet seven years old.
  IF OLD.occurred_at >= pg_catalog.now() - pg_catalog.make_interval(years => 7) THEN
    RAISE EXCEPTION 'account_deletion_events retention: row is not yet seven years old'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN OLD;
END;
$fn$;

DROP TRIGGER IF EXISTS account_deletion_events_append_only ON public.account_deletion_events;
CREATE TRIGGER account_deletion_events_append_only
  BEFORE UPDATE OR DELETE ON public.account_deletion_events
  FOR EACH ROW EXECUTE FUNCTION public.tg_account_deletion_events_append_only();

-- A row trigger does not fire on TRUNCATE, so TRUNCATE gets its own statement-level guard.
DROP TRIGGER IF EXISTS account_deletion_events_no_truncate ON public.account_deletion_events;
CREATE TRIGGER account_deletion_events_no_truncate
  BEFORE TRUNCATE ON public.account_deletion_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.tg_account_deletion_events_append_only();

-- ── Row-level security ────────────────────────────────────────────────────────────────────────
-- ENABLED WITH ZERO POLICIES. No policy means no row is visible or writable to any role subject to
-- RLS. There is no browser-readable deletion history and no policy exists that could create one.
--
-- FORCE is deliberately NOT set: it would apply RLS to the table owner, and the SECURITY DEFINER
-- writers run as the owner — enabling FORCE would silently break every write to this table.
ALTER TABLE public.account_deletion_events ENABLE ROW LEVEL SECURITY;

-- ── Privileges ────────────────────────────────────────────────────────────────────────────────
-- A GRANT IS ADDITIVE; ONLY REVOKE REMOVES. Supabase projects carry `ALTER DEFAULT PRIVILEGES ...
-- GRANT ALL ON TABLES TO ...`, so a newly created table arrives ALREADY holding UPDATE, DELETE,
-- TRUNCATE, REFERENCES and TRIGGER before this file grants anything. Granting only the verbs we
-- want would leave every verb we do not want in place. REVOKE ALL first is the only correct shape.
-- This is the fourth time this default has bitten this codebase (070, 072, 074), which is why the
-- verification harness now reproduces it rather than testing on a bare cluster.
REVOKE ALL ON public.account_deletion_events FROM PUBLIC;
REVOKE ALL ON public.account_deletion_events FROM anon;
REVOKE ALL ON public.account_deletion_events FROM authenticated;
REVOKE ALL ON public.account_deletion_events FROM service_role;

-- Belt and braces: name the unwanted verbs explicitly, so the intent survives even if a future
-- edit weakens the REVOKE ALL above.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.account_deletion_events FROM PUBLIC, anon, authenticated, service_role;

-- Exactly two verbs, to exactly one role.
GRANT SELECT, INSERT ON public.account_deletion_events TO service_role;

-- ── The recording function ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_account_deletion_event(
  p_deletion_id     uuid,
  p_stage           text,
  p_actor_category  text,
  p_deletion_path   text,
  p_deleted_user_id uuid  DEFAULT NULL,
  p_reason_category text  DEFAULT NULL,
  p_object_counts   jsonb DEFAULT NULL,
  p_error_class     text  DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_id  uuid;
  v_key text;
BEGIN
  IF p_deletion_id IS NULL THEN
    RAISE EXCEPTION 'deletion_id is required';
  END IF;

  -- IDEMPOTENCY KEY. deletion_id + stage. Application code and the database triggers both write the
  -- same key for the same transition, so whichever arrives second is a no-op instead of a
  -- conflicting duplicate. This is what allows database-level capture to coexist with the normal
  -- application flow without producing two completed events for one deletion.
  v_key := p_deletion_id::text || ':' || p_stage;

  INSERT INTO public.account_deletion_events (
    deletion_id, event_key, stage, actor_category, deletion_path,
    reason_category, deleted_user_id, object_counts, error_class
  ) VALUES (
    p_deletion_id, v_key, p_stage, p_actor_category, p_deletion_path,
    p_reason_category, p_deleted_user_id, p_object_counts, p_error_class
  )
  ON CONFLICT ON CONSTRAINT account_deletion_events_event_key_uniq DO NOTHING
  RETURNING id INTO v_id;

  -- Idempotent replay: the row already exists, which is success, not failure.
  IF v_id IS NULL THEN
    SELECT e.id INTO v_id FROM public.account_deletion_events e WHERE e.event_key = v_key;
  END IF;

  RETURN v_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.record_account_deletion_event(uuid, text, text, text, uuid, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_account_deletion_event(uuid, text, text, text, uuid, text, jsonb, text)
  TO service_role;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — DATABASE-LEVEL CAPTURE
--
-- Application code cannot see a deletion performed through the Supabase dashboard, the Auth Admin
-- API, a psql session, or a cascade. Those paths bypass Next.js entirely, so a ledger written only
-- by the application would have a hole exactly where the original incident happened. Triggers close
-- it, because they fire wherever the DELETE originates.
--
-- SUPPORTED HERE, ON EVIDENCE: migration 059 records a production preflight confirming auth.users
-- already carries a non-internal trigger (on_auth_user_email_verified). Triggers on auth.users are
-- therefore a working pattern in THIS database, not an assumption.
--
-- ATTRIBUTION RULE. The trigger inherits actor_category and deletion_path from an existing
-- 'requested' event for the same deletion_id when one is present — which is how an application path
-- keeps its correct attribution ('self', 'admin'). When no 'requested' event exists, nothing in the
-- application opened this deletion, so it records actor 'system' and path 'out_of_band' and writes
-- the missing 'requested' event itself, leaving a complete lifecycle rather than an orphan.
--
-- TRADE-OFF, STATED PLAINLY: because the ledger write happens inside the deleting transaction, a
-- ledger that cannot be written makes the DELETE fail — everywhere, including the Supabase
-- dashboard. That is fail-closed by design and is the strongest available guarantee, but it does
-- mean a broken ledger blocks deletions rather than silently losing them. That is the intended
-- ordering of harms; it is not a side effect.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.tg_capture_account_deletion()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_uid   uuid := OLD.id;
  v_actor text;
  v_path  text;
  v_stage text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN OLD;
  END IF;

  -- Inherit attribution from the application, if the application opened this deletion.
  SELECT e.actor_category, e.deletion_path
    INTO v_actor, v_path
    FROM public.account_deletion_events e
   WHERE e.deletion_id = v_uid AND e.stage = 'requested'
   LIMIT 1;

  IF v_actor IS NULL THEN
    -- Nothing in the application opened this. It is out-of-band, and honestly recorded as such.
    v_actor := 'system';
    v_path  := 'out_of_band';
    PERFORM public.record_account_deletion_event(
      v_uid, 'requested', v_actor, v_path, v_uid, 'unspecified', NULL, NULL);
  END IF;

  -- Which transition this DELETE represents is decided by WHICH TABLE fired, not by a guess.
  --
  -- ORDERING, RECORDED RATHER THAN SMOOTHED OVER: for a deletion that starts at auth.users, this
  -- BEFORE trigger fires first and the profile row is only removed afterwards by ON DELETE CASCADE.
  -- The true chronology is therefore requested -> auth_deleted -> data_deleted, which is the
  -- reverse of the application path's narrative order. Every transition is still present; read the
  -- lifecycle as a SET of stages, not as a timeline. Reordering the timestamps to look tidier would
  -- mean stamping an audit record with times at which nothing happened.
  v_stage := CASE TG_TABLE_SCHEMA WHEN 'auth' THEN 'auth_deleted' ELSE 'data_deleted' END;

  PERFORM public.record_account_deletion_event(
    v_uid, v_stage, v_actor, v_path, v_uid, NULL, NULL, NULL);

  RETURN OLD;
END;
$fn$;

REVOKE ALL ON FUNCTION public.tg_capture_account_deletion() FROM PUBLIC, anon, authenticated;

-- profiles: catches a direct profile deletion (path 3) and the profile half of any deletion.
DROP TRIGGER IF EXISTS capture_profile_deletion ON public.profiles;
CREATE TRIGGER capture_profile_deletion
  BEFORE DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_capture_account_deletion();

-- auth.users: catches the Auth Admin API (path 4) and dashboard / direct SQL deletion (path 5).
-- The Auth Admin API removes the row with ordinary SQL server-side, so this trigger fires for it.
DROP TRIGGER IF EXISTS capture_auth_user_deletion ON auth.users;
CREATE TRIGGER capture_auth_user_deletion
  BEFORE DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.tg_capture_account_deletion();

-- ── Bulk TRUNCATE of profiles ─────────────────────────────────────────────────────────────────
-- A row trigger does NOT fire on TRUNCATE, so a bulk truncate would erase every member with no
-- ledger entry at all. This statement-level trigger cannot enumerate the rows — that information is
-- gone by construction — but it records that a bulk removal happened, with a count, which is the
-- difference between a visible anomaly and a silent one.
CREATE OR REPLACE FUNCTION public.tg_capture_profiles_truncate()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.profiles;
  PERFORM public.record_account_deletion_event(
    gen_random_uuid(), 'data_deleted', 'system', 'out_of_band', NULL, 'unspecified',
    jsonb_build_object('profiles_truncated', v_n), NULL);
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.tg_capture_profiles_truncate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS capture_profiles_truncate ON public.profiles;
CREATE TRIGGER capture_profiles_truncate
  BEFORE TRUNCATE ON public.profiles
  FOR EACH STATEMENT EXECUTE FUNCTION public.tg_capture_profiles_truncate();

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — RETENTION PURGE (approved: retain up to seven years, then delete automatically)
--
-- ONE function, no arguments, one aggregate return value. Deliberately NOT parameterised: it takes
-- no user id, no email, no date, no interval and no retention period, so there is no input through
-- which it could be aimed at a particular member or used to shorten the window. The seven-year
-- boundary is fixed in the body AND independently re-checked by the append-only trigger, so a
-- future edit here cannot widen it on its own.
--
-- EARLIER REMOVAL is deliberately NOT buildable through this function. A documented legal/privacy
-- process may remove a record sooner; that is a reviewed manual operation, and no arbitrary
-- per-user deletion endpoint exists to be misused in the meantime.
--
-- NO BACKFILL. This migration creates no historical rows. The ledger begins empty and records only
-- deletions that happen after it is applied — inventing events for past deletions would be
-- fabricating audit evidence.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.purge_expired_account_deletion_events()
  RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_removed bigint;
BEGIN
  -- Transaction-local (third argument true), so the marker cannot leak into another statement, a
  -- pooled connection's next transaction, or a concurrent session.
  PERFORM pg_catalog.set_config('andrel.retention_purge', 'on', true);

  DELETE FROM public.account_deletion_events
   WHERE occurred_at < pg_catalog.now() - pg_catalog.make_interval(years => 7);

  GET DIAGNOSTICS v_removed = ROW_COUNT;

  -- Close the door immediately, so nothing later in the same transaction inherits it.
  PERFORM pg_catalog.set_config('andrel.retention_purge', 'off', true);

  -- An aggregate count and nothing else. No id, no timestamp, no category, no sample row: the
  -- return value of a retention job must not become a channel for reading the records it deletes.
  RETURN v_removed;
END;
$fn$;

REVOKE ALL ON FUNCTION public.purge_expired_account_deletion_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_expired_account_deletion_events() FROM anon;
REVOKE ALL ON FUNCTION public.purge_expired_account_deletion_events() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_account_deletion_events() TO service_role;

COMMENT ON FUNCTION public.purge_expired_account_deletion_events() IS
  'Deletes account_deletion_events rows older than exactly seven years. No arguments; returns the '
  'number removed. service_role only. The seven-year boundary is enforced both here and by the '
  'append-only trigger. See migration 075.';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- PART 5 — THE SELF-SERVICE PATH, FAIL-CLOSED
--
-- The sequence a–k is transcribed UNCHANGED from migration 059, in the same order with the same
-- predicates. The additions are: counts captured BEFORE anything is destroyed, and ledger writes.
--
-- WHY THIS PATH IS GENUINELY ATOMIC, AND WHERE THE CLAIM STOPS. This function removes the auth
-- identity with `DELETE FROM auth.users` — ordinary SQL inside the caller's transaction, NOT the
-- Auth Admin API — so the ledger write, the row deletions and the auth deletion genuinely share one
-- transaction. The record cannot be lost while the deletion succeeds, because losing it would mean
-- rolling the deletion back too.
--
-- That claim is TRUE FOR THIS PATH ONLY. A deletion performed through the Auth Admin API over HTTP
-- CANNOT share this transaction, and no amount of SQL makes it atomic. No cross-system atomicity is
-- claimed anywhere in this design.
--
-- CONSEQUENCE, STATED RATHER THAN GLOSSED: on this path a 'failed' event is never written, and that
-- is correct. A failure rolls the whole transaction back, so nothing was deleted and there is
-- nothing to have failed. A row asserting a deletion that did not happen is worse than no row.
--
-- deletion_id IS v_uid, so the events written here and the events written by the triggers converge
-- on one lifecycle instead of two.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.delete_user_account()
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_counts jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Capture the aggregate shape of what is about to be destroyed, BEFORE destroying it. Counts
  -- only; nothing here can carry an identity, an address or any content.
  SELECT jsonb_build_object(
    'messages',            (SELECT count(*) FROM public.messages       WHERE sender_id = v_uid),
    'matches',             (SELECT count(*) FROM public.matches        WHERE user_a_id = v_uid OR user_b_id = v_uid),
    'conversations',       (SELECT count(*) FROM public.conversations c
                              JOIN public.matches m ON c.match_id = m.id
                             WHERE m.user_a_id = v_uid OR m.user_b_id = v_uid),
    'intro_requests',      (SELECT count(*) FROM public.intro_requests WHERE requester_id = v_uid OR target_user_id = v_uid),
    'meetings',            (SELECT count(*) FROM public.meetings       WHERE requester_id = v_uid OR recipient_id = v_uid),
    'notifications',       (SELECT count(*) FROM public.notifications  WHERE user_id = v_uid),
    'credit_transactions', (SELECT count(*) FROM public.credit_transactions WHERE user_id = v_uid)
  ) INTO v_counts;

  -- Write the record BEFORE the first destructive statement. If this fails, the exception aborts
  -- the transaction and NOTHING below runs. That ordering is the entire fail-closed guarantee.
  PERFORM public.record_account_deletion_event(
    v_uid, 'requested', 'self', 'self_service_rpc', v_uid, 'member_request', v_counts, NULL);

  DELETE FROM public.messages WHERE sender_id = v_uid;                                    -- a
  DELETE FROM public.conversations                                                        -- b
   WHERE id IN (
     SELECT c.id FROM public.conversations c
     JOIN public.matches m ON c.match_id = m.id
     WHERE m.user_a_id = v_uid OR m.user_b_id = v_uid
   );
  DELETE FROM public.matches WHERE user_a_id = v_uid OR user_b_id = v_uid;                -- c
  DELETE FROM public.intro_requests WHERE requester_id = v_uid OR target_user_id = v_uid; -- d
  DELETE FROM public.meeting_credits WHERE user_id = v_uid;                               -- e
  DELETE FROM public.credit_transactions WHERE user_id = v_uid;                           -- f
  DELETE FROM public.meetings WHERE requester_id = v_uid OR recipient_id = v_uid;         -- g
  DELETE FROM public.notifications WHERE user_id = v_uid;                                 -- h
  DELETE FROM public.profiles WHERE id = v_uid;                                           -- i
  DELETE FROM public.waitlist                                                             -- j
   WHERE email = (SELECT u.email FROM auth.users u WHERE u.id = v_uid);

  -- The profiles trigger already wrote this at step (i); the key is identical, so this is a no-op.
  -- It is kept so the guarantee does not depend on the trigger existing.
  PERFORM public.record_account_deletion_event(
    v_uid, 'data_deleted', 'self', 'self_service_rpc', v_uid, 'member_request', NULL, NULL);

  DELETE FROM auth.users WHERE id = v_uid;                                                -- k

  PERFORM public.record_account_deletion_event(
    v_uid, 'auth_deleted', 'self', 'self_service_rpc', v_uid, 'member_request', NULL, NULL);
END;
$$;

-- Grants restated exactly as 059 left them. CREATE OR REPLACE preserves privileges, so this is an
-- assertion of the intended state rather than a change.
REVOKE ALL ON FUNCTION public.delete_user_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_user_account() TO authenticated, service_role;

COMMIT;
