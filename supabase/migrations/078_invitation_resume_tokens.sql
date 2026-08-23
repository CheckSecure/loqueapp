-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 078 — INVITATION RESUME TOKENS
--
-- WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT.
-- A resume token AUTHENTICATES NOBODY. It is a revocable server-side reference to an invitation.
-- Presenting it does exactly one thing: it asks the server to send a FRESH secure sign-in email,
-- through the existing hardened invitation ceremony, to the address ALREADY ON THE INVITATION.
-- A forwarded or stolen token therefore cannot let the holder in — the most it can do is cause an
-- email to arrive in the rightful owner's inbox. That property, not an expiry, is what makes a
-- long-lived token acceptable here.
--
-- ONLY THE SHA-256 IS STORED. The plaintext exists once, in the email body. A database compromise
-- yields no usable token, and there is nothing to log even by accident.
--
-- ─── NO FOREIGN KEYS, AND THE LIFECYCLE THAT JUSTIFIES IT ─────────────────────────────────────
-- waitlist_id and auth_user_id carry NO references. A FK to waitlist would block the manage-link
-- deletion path (/api/manage-information/delete deletes waitlist rows outright) unless it cascaded,
-- and a cascade would silently destroy the revocation record. A FK to auth.users would be deleted
-- out from under us by delete_user_account() and by the admin revoke path. The token row instead
-- RESOLVES at request time: a token whose waitlist row no longer exists resolves to nothing and the
-- caller receives the same generic unavailable response as a forged token. Deletion therefore
-- invalidates by construction, without a constraint that could block the deletion itself.
--
-- ─── NO EMAIL IS STORED HERE ──────────────────────────────────────────────────────────────────
-- The address lives on the waitlist row and is resolved by join. Duplicating it into this table
-- would create a second copy of personal data with its own deletion path to get wrong.
--
-- ─── TERMINAL EVENTS (no expiry) ──────────────────────────────────────────────────────────────
-- ─── TWO KINDS OF LINK, AND ONLY ONE OF THEM EXPIRES ──────────────────────────────────────────
--   • A Supabase authentication link (invite/recovery) SIGNS SOMEONE IN and expires by design.
--   • A resume link authenticates NOBODY and does not expire. It only asks us to send a fresh
--     authentication link to the address already on the invitation.
-- Every invitation email carries both: the button is the authentication link, and the fallback is
-- the resume link, so the email stays useful after its primary link dies.
--
-- ISSUING A NEW RESUME TOKEN NEVER RETIRES AN OLDER ONE. Reminders and access-resends add tokens;
-- they do not rotate. Only an explicit admin rotation retires live tokens, and only after the
-- replacement email has been definitely accepted (see finalize_resume_rotation).
--
-- ─── TERMINAL EVENTS ──────────────────────────────────────────────────────────────────────────
--   profile_complete = true | waitlist status is anything but 'invited' | the unique auth identity
--   for the invitation no longer equals the one bound at issuance (deleted, recreated or replaced)
--   | admin rotation or revocation | the invitation row is gone.
-- Opening the page or requesting a fresh email does NOT consume or rotate the token: the whole
-- point is that the same reminder link still works after the emailed sign-in link expires.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.invitation_resume_tokens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- SHA-256 of the base64url token. bytea, not text: fixed width, no encoding ambiguity, and it
  -- cannot be mistaken for something presentable. UNIQUE both for lookup and to make a collision a
  -- constraint violation rather than an ambiguous match.
  token_sha256       bytea NOT NULL,

  -- Deliberately NOT foreign keys. See the header.
  --
  -- auth_user_id IS NOT NULL, and that is load-bearing. The claim function proves the CURRENT unique
  -- auth identity for the invitation still equals this stored uuid before it will do anything. With
  -- a nullable column the completion check `WHERE p.id = t.auth_user_id` silently matched no row, so
  -- a completed profile never invalidated the token. Requiring it here makes that failure mode
  -- unrepresentable rather than merely unlikely. There is no lifecycle that needs a token without a
  -- resolved identity: a resume link exists to sign a SPECIFIC person in.
  waitlist_id        uuid NULL,
  auth_user_id       uuid NOT NULL,

  issued_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz NULL,
  -- Set on the OLD row when an admin reissues; the new row is a separate insert.
  superseded_at      timestamptz NULL,

  -- Durable per-token rate limiting. A fixed window is used rather than a sliding one because the
  -- limit only has to stop email bombing, and a fixed window is a single atomic UPDATE.
  window_started_at  timestamptz NULL,
  window_count       integer NOT NULL DEFAULT 0 CHECK (window_count >= 0),
  request_count      integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  last_requested_at  timestamptz NULL,

  CONSTRAINT invitation_resume_tokens_hash_uniq UNIQUE (token_sha256),
  -- 32 bytes in, 32 bytes out. A wrong-length value means something other than SHA-256 was stored.
  CONSTRAINT invitation_resume_tokens_hash_len CHECK (octet_length(token_sha256) = 32)
);

-- MULTIPLE LIVE TOKENS PER INVITATION ARE INTENDED. There is deliberately no unique index here.
--
-- An earlier draft allowed only one live token, which forced each new reminder to supersede the
-- previous one — so issuing stage 2 killed the link in the stage-1 email the member was still
-- looking at. That directly contradicts the requirement that an earlier reminder stay usable until
-- a terminal event, and it recreated the original complaint: links dying before completion.
--
-- Plaintext cannot be recovered from a stored digest, so reusing one link across stages would mean
-- persisting the token (or a reversible form of it), which is exactly what must not happen. Issuing
-- a fresh hash per reminder and letting them ALL stay valid is the only design that keeps every
-- emailed link working without ever storing anything recoverable.
--
-- Validity is decided at claim time, not by which row is newest: completion, revocation, decline,
-- identity replacement and invitation deletion invalidate EVERY token for that invitation at once,
-- because the claim re-resolves the invitation and identity on every request. Admin rotation
-- supersedes all live rows explicitly.
CREATE INDEX IF NOT EXISTS invitation_resume_tokens_waitlist_idx
  ON public.invitation_resume_tokens (waitlist_id)
  WHERE revoked_at IS NULL AND superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS invitation_resume_tokens_auth_idx
  ON public.invitation_resume_tokens (auth_user_id) WHERE auth_user_id IS NOT NULL;

COMMENT ON TABLE public.invitation_resume_tokens IS
  'Revocable server-side invitation references. NOT credentials: presenting one only requests a '
  'fresh secure sign-in email to the address already on the invitation. Stores ONLY sha256 of the '
  'token; never the plaintext, never an email address. No FKs, so deletion invalidates by '
  'resolution failure rather than by cascade. See migration 078.';

-- ── Global rate limit bucket ──────────────────────────────────────────────────────────────────
-- Per-token limiting alone cannot stop someone who harvests many reminder emails. One row per
-- minute; the worker upserts and reads the count in a single statement.
CREATE TABLE IF NOT EXISTS public.invitation_resume_rate (
  minute_bucket timestamptz PRIMARY KEY,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0)
);

COMMENT ON TABLE public.invitation_resume_rate IS
  'Global per-minute request counter for the resume endpoint. Aggregate only — no identity, no '
  'token, no address.';

-- ── Row-level security: enabled, ZERO policies. No browser role reaches either table. ─────────
ALTER TABLE public.invitation_resume_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitation_resume_rate   ENABLE ROW LEVEL SECURITY;

-- ── Privileges ────────────────────────────────────────────────────────────────────────────────
-- REVOKE ALL FIRST. Supabase's ALTER DEFAULT PRIVILEGES grants broad table access at CREATE TABLE
-- time, so these tables arrive already holding verbs nobody asked for. Granting only what we want
-- would leave everything we do not want in place. This has bitten this codebase four times.
REVOKE ALL ON public.invitation_resume_tokens FROM PUBLIC;
REVOKE ALL ON public.invitation_resume_tokens FROM anon;
REVOKE ALL ON public.invitation_resume_tokens FROM authenticated;
REVOKE ALL ON public.invitation_resume_tokens FROM service_role;
REVOKE ALL ON public.invitation_resume_rate FROM PUBLIC;
REVOKE ALL ON public.invitation_resume_rate FROM anon;
REVOKE ALL ON public.invitation_resume_rate FROM authenticated;
REVOKE ALL ON public.invitation_resume_rate FROM service_role;

-- Name the unwanted verbs explicitly too, so intent survives a future edit to the blanket revoke.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.invitation_resume_tokens
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.invitation_resume_rate
  FROM PUBLIC, anon, authenticated, service_role;

-- service_role needs UPDATE here (unlike the deletion ledger) because rate counters and revocation
-- are updates by design. DELETE is NOT granted: tokens are revoked, never erased.
GRANT SELECT, INSERT, UPDATE ON public.invitation_resume_tokens TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.invitation_resume_rate   TO service_role;

-- ═══ THE AUTHORITATIVE IDENTITY RESOLVER ════════════════════════════════════════════════════════
-- ONE way to answer "who is the auth user for this address". The application previously called a
-- function that did not exist and fell back to admin.auth.admin.listUsers({page:1, perPage:200}) —
-- which reads only the FIRST PAGE. Production holds more identities than that, so the fallback
-- reported ZERO users for anyone beyond page one, and "zero users" is indistinguishable from
-- "ambiguous" in every eligibility rule that consumes it. People were silently unreachable.
--
-- Returns only what the callers need: a count, the uuid when the count is exactly 1, and the
-- last-sign-in timestamp. It emits NO email address, so a caller that logs the result cannot leak
-- one, and it accepts only an exact normalized address — there is no pattern, no prefix and no way
-- to enumerate.
CREATE OR REPLACE FUNCTION public.lookup_auth_identity(p_email text)
  RETURNS TABLE (identity_count integer, auth_user_id uuid, last_sign_in_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_norm text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
BEGIN
  IF v_norm = '' THEN
    RETURN QUERY SELECT 0, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;

  RETURN QUERY
  SELECT (pg_catalog.count(*))::integer,
         -- Meaningful ONLY when the count is 1. A caller that ignores the count and uses this uuid
         -- anyway would be acting on an ambiguous identity, so it is NULL in that case by design.
         CASE WHEN pg_catalog.count(*) = 1 THEN (pg_catalog.array_agg(u.id))[1] END,
         pg_catalog.max(u.last_sign_in_at)
  FROM auth.users u
  WHERE pg_catalog.lower(pg_catalog.btrim(u.email)) = v_norm;
END;
$fn$;

REVOKE ALL ON FUNCTION public.lookup_auth_identity(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lookup_auth_identity(text) FROM anon;
REVOKE ALL ON FUNCTION public.lookup_auth_identity(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_auth_identity(text) TO service_role;

COMMENT ON FUNCTION public.lookup_auth_identity(text) IS
  'THE identity resolver. Exact normalized address in; count + unique uuid + last_sign_in_at out. '
  'Emits no email. service_role only. Replaces a paged listUsers() fallback that read only the '
  'first 200 identities and reported zero for everyone else. See migration 078.';

-- ═══ THE WAITLIST-STATE RESOLVER ════════════════════════════════════════════════════════════════
-- The companion to lookup_auth_identity(): answers "what is the invitation state for this address"
-- under the SAME exact normalization contract, so the two can never disagree.
--
-- WHY THIS EXISTS. The initializer previously matched with ILIKE, which is a pattern match, not the
-- normalization every other path uses: an address containing % or _ would match rows it should not,
-- and leading/trailing whitespace is compared rather than trimmed. Two different notions of "same
-- address" in one authorization decision is exactly the kind of seam that turns into a bypass.
--
-- Returns COUNTS and one id — never an address, never a status string that could be echoed back to
-- a caller as an existence oracle.
CREATE OR REPLACE FUNCTION public.lookup_waitlist_identity(p_email text)
  RETURNS TABLE (
    total_rows        integer,
    invited_count     integer,
    invited_id        uuid,
    has_revoked       boolean,
    has_declined      boolean,
    has_other_status  boolean
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_norm text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
BEGIN
  IF v_norm = '' THEN
    RETURN QUERY SELECT 0, 0, NULL::uuid, false, false, false; RETURN;
  END IF;

  RETURN QUERY
  SELECT (pg_catalog.count(*))::integer,
         (pg_catalog.count(*) FILTER (WHERE w.status = 'invited'))::integer,
         -- Meaningful ONLY when invited_count = 1; a caller that ignores the count and uses this id
         -- anyway would be acting on an ambiguous invitation, so it is NULL otherwise by design.
         CASE WHEN pg_catalog.count(*) FILTER (WHERE w.status = 'invited') = 1
              THEN (pg_catalog.array_agg(w.id) FILTER (WHERE w.status = 'invited'))[1] END,
         pg_catalog.bool_or(w.status = 'revoked'),
         pg_catalog.bool_or(w.status = 'declined'),
         pg_catalog.bool_or(w.status NOT IN ('invited', 'revoked', 'declined'))
  FROM public.waitlist w
  WHERE pg_catalog.lower(pg_catalog.btrim(w.email)) = v_norm;
END;
$fn$;

REVOKE ALL ON FUNCTION public.lookup_waitlist_identity(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lookup_waitlist_identity(text) FROM anon;
REVOKE ALL ON FUNCTION public.lookup_waitlist_identity(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_waitlist_identity(text) TO service_role;

COMMENT ON FUNCTION public.lookup_waitlist_identity(text) IS
  'Invitation state for an exact normalized address. Counts plus one id; emits no address and no '
  'status string. Same normalization as lookup_auth_identity(). service_role only. See 078.';

-- ═══ ATOMIC RESUME-ACCESS CLAIM ═════════════════════════════════════════════════════════════════
-- Replaces a check-then-insert in application code that could not possibly be safe.
--
-- ─── WHY THE APPLICATION VERSION RACED ────────────────────────────────────────────────────────
-- It SELECTed for a recent 'claimed' row and then, separately, INSERTed one. Two concurrent presses
-- both read "nothing in flight" and both proceeded to the provider — two emails. Nothing in the
-- schema serialized them either: resume_access rows carry waitlist_id NULL precisely to escape
-- migration 049's one-per-purpose index, so that index does not apply. There was no boundary at all.
--
-- The check and the insert now happen in ONE transaction under a TRANSACTION-SCOPED ADVISORY LOCK
-- keyed on the bound auth user. Advisory rather than a unique index because the rule is not "one row
-- ever" — a member is ALLOWED repeat requests, just not simultaneous or rapid ones — and a partial
-- unique index cannot express "at most one active, but more later". The lock is released when the
-- transaction ends, so nothing can leak a permanent hold.
--
-- ─── STATES, AND WHY TIME ALONE NEVER UNLOCKS AN UNCERTAIN SEND ───────────────────────────────
--   created           a fresh claim; the caller may call the provider exactly once
--   in_flight         another claim is live and pre-dispatch; do nothing
--   uncertain_review  a previous attempt either BEGAN a provider call ('dispatching') or reached
--                     the provider with an UNKNOWN outcome ('uncertain'). Both are TERMINAL for
--                     automatic retry. Neither expires, and no amount of elapsed time converts them
--                     into a fresh claim, because "we do not know" does not become "it failed" just
--                     because a minute passed. Only webhook evidence (which moves the row to
--                     delivered/bounced/failed) or explicit admin review resolves them.
--   debounced         an accepted send is very recent; a second press changes nothing
--
-- A STALE PRE-DISPATCH claim is different and IS safely retryable: dispatch_state 'pending' means
-- the provider was never called, so no message exists to duplicate. Such a row is retired as
-- 'failed' with a closed-vocabulary class and a new claim is issued — visible, not a silent lockout.
CREATE OR REPLACE FUNCTION public.claim_resume_access_attempt(
  p_auth_user_id    uuid,
  p_email           text,
  p_lease_minutes   integer DEFAULT 15,
  p_debounce_minutes integer DEFAULT 5
) RETURNS TABLE (out_state text, out_delivery_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_norm    text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  v_row     public.invitation_deliveries%ROWTYPE;
  v_new_id  uuid;
BEGIN
  IF p_auth_user_id IS NULL OR v_norm = '' THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid; RETURN;
  END IF;

  -- Transaction-scoped advisory lock on (auth user, purpose). Concurrent callers serialize here;
  -- the lock is released at COMMIT or ROLLBACK, so a crash cannot strand it.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_auth_user_id::text || ':resume_access', 0));

  -- NON-RETRYABLE STATES FIRST. Both 'dispatching' (the provider call began and may have happened)
  -- and 'uncertain' (it happened and we do not know the outcome) are terminal for automatic retry,
  -- and must not be overtaken by any time-based branch below. Neither expires.
  SELECT d.* INTO v_row FROM public.invitation_deliveries d
   WHERE d.auth_user_id = p_auth_user_id
     AND d.purpose = 'resume_access'
     AND d.status = 'claimed'
     AND d.dispatch_state IN ('dispatching', 'uncertain')
   ORDER BY d.attempted_at DESC LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'uncertain_review'::text, v_row.id; RETURN;
  END IF;

  -- A live pre-dispatch claim inside its lease: someone else is mid-flight right now.
  SELECT d.* INTO v_row FROM public.invitation_deliveries d
   WHERE d.auth_user_id = p_auth_user_id
     AND d.purpose = 'resume_access'
     AND d.status = 'claimed'
     AND coalesce(d.dispatch_state, 'pending') = 'pending'
     AND d.attempted_at > pg_catalog.now() - pg_catalog.make_interval(mins => p_lease_minutes)
   ORDER BY d.attempted_at DESC LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'in_flight'::text, v_row.id; RETURN;
  END IF;

  -- Debounce a rapid second press after a send the provider definitely accepted.
  SELECT d.* INTO v_row FROM public.invitation_deliveries d
   WHERE d.auth_user_id = p_auth_user_id
     AND d.purpose = 'resume_access'
     AND d.status IN ('accepted', 'delivered')
     AND d.attempted_at > pg_catalog.now() - pg_catalog.make_interval(mins => p_debounce_minutes)
   ORDER BY d.attempted_at DESC LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'debounced'::text, v_row.id; RETURN;
  END IF;

  -- Retire any stale PRE-DISPATCH claims. The provider was never called for these, so retiring them
  -- cannot duplicate a message. Recorded with a closed-vocabulary class, never a provider string.
  UPDATE public.invitation_deliveries d
     SET status = 'failed', error_class = 'stale_pre_dispatch'
   WHERE d.auth_user_id = p_auth_user_id
     AND d.purpose = 'resume_access'
     AND d.status = 'claimed'
     AND coalesce(d.dispatch_state, 'pending') = 'pending'
     AND d.attempted_at <= pg_catalog.now() - pg_catalog.make_interval(mins => p_lease_minutes);

  INSERT INTO public.invitation_deliveries
    (waitlist_id, auth_user_id, recipient_email, purpose, status, dispatch_state, attempt_number)
  VALUES (NULL, p_auth_user_id, v_norm, 'resume_access', 'claimed', 'pending', 1)
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT 'created'::text, v_new_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.claim_resume_access_attempt(uuid, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_resume_access_attempt(uuid, text, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_resume_access_attempt(uuid, text, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_resume_access_attempt(uuid, text, integer, integer) TO service_role;

COMMENT ON FUNCTION public.claim_resume_access_attempt(uuid, text, integer, integer) IS
  'Atomic resume-access claim under a transaction advisory lock keyed on the bound auth user. '
  'Returns created / in_flight / uncertain_review / debounced. An uncertain provider outcome is '
  'terminal for automatic retry and never expires. See migration 078.';

-- ═══ THE PRE-PROVIDER DISPATCH MARKER ═══════════════════════════════════════════════════════════
-- Moves exactly one claim from (claimed, pending) to (claimed, dispatching) and reports whether it
-- did. The caller MUST NOT contact the provider unless this returns true.
--
-- The predicate is the whole point: it matches only a row that is still genuinely pre-dispatch, so
-- a second caller — or a retry of the same caller — cannot re-enter the dispatch path for a claim
-- that has already begun one. `GET DIAGNOSTICS ROW_COUNT` gives an exact-one guarantee that an
-- application-side update cannot: PostgREST reports no error when a filter matches zero rows, so a
-- client-side "update then hope" would sail past a lost race and call the provider anyway.
CREATE OR REPLACE FUNCTION public.begin_resume_dispatch(p_delivery_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_n integer;
BEGIN
  IF p_delivery_id IS NULL THEN RETURN false; END IF;

  UPDATE public.invitation_deliveries d
     SET dispatch_state = 'dispatching'
   WHERE d.id = p_delivery_id
     AND d.purpose = 'resume_access'
     AND d.status = 'claimed'
     AND coalesce(d.dispatch_state, 'pending') = 'pending';

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$fn$;

REVOKE ALL ON FUNCTION public.begin_resume_dispatch(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.begin_resume_dispatch(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.begin_resume_dispatch(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.begin_resume_dispatch(uuid) TO service_role;

COMMENT ON FUNCTION public.begin_resume_dispatch(uuid) IS
  'Atomically marks a resume_access claim as ''dispatching'' immediately before the provider call. '
  'Returns true only if exactly one still-pre-dispatch row transitioned; the caller must not '
  'contact the provider otherwise. See migration 078.';

-- ═══ ROTATION OPERATIONS ════════════════════════════════════════════════════════════════════════
-- A durable state machine for admin rotation. Without it, a rotation whose email was ACCEPTED but
-- whose finalization then failed was unrecoverable: a retry found the existing delivery claim,
-- reported "in flight", and had no way to know WHICH replacement token was supposed to be kept. The
-- member's old links stayed live, the new one stayed live, and nothing could ever complete the
-- rotation. The operation row is the missing memory.
--
-- NO FOREIGN KEYS, for the same reason as the token table: this must survive the deletion of the
-- things it refers to, and a FK would either block that deletion or cascade the record away.
--
-- NO EMAIL, NO PLAINTEXT TOKEN. Only ids, a state and timestamps.
CREATE TABLE IF NOT EXISTS public.invitation_rotation_operations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waitlist_id          uuid NOT NULL,
  auth_user_id         uuid NOT NULL,
  -- The token that MUST be kept when this operation finalizes. NOT NULL: an operation that does not
  -- know its own replacement cannot be resumed, which is the exact defect being fixed.
  replacement_token_id uuid NOT NULL,
  delivery_id          uuid NULL,
  -- Stable across retries so a resumed operation reuses one provider idempotency key.
  event_key            text NOT NULL,

  state                text NOT NULL DEFAULT 'prepared' CHECK (state IN (
                         'prepared',                 -- token minted, nothing sent yet
                         'accepted_pending_finalize',-- provider took it; older tokens not yet retired
                         'finalized',                -- older tokens retired; done
                         'failed',                   -- definite send failure; retryable
                         'uncertain'                 -- provider outcome unknown; NOT resendable
                       )),
  error_class          text NULL CHECK (error_class IS NULL OR error_class ~ '^[a-z0-9_]{1,40}$'),

  prepared_at          timestamptz NOT NULL DEFAULT now(),
  accepted_at          timestamptz NULL,
  finalized_at         timestamptz NULL,
  failed_at            timestamptz NULL,

  CONSTRAINT invitation_rotation_operations_event_key_uniq UNIQUE (event_key)
);

-- AT MOST ONE ACTIVE OPERATION PER INVITATION. This is the rotation concurrency boundary, and it is
-- deliberately here rather than on the delivery row: a terminal 'accepted' delivery can never be
-- released, whereas an operation moves to 'finalized' or 'failed' and frees the invitation for a
-- future rotation. 'uncertain' is included in the active set on purpose — an unresolved send must
-- not be repeatable until delivery evidence settles it.
CREATE UNIQUE INDEX IF NOT EXISTS invitation_rotation_operations_active_uniq
  ON public.invitation_rotation_operations (waitlist_id)
  WHERE state IN ('prepared', 'accepted_pending_finalize', 'uncertain');

CREATE INDEX IF NOT EXISTS invitation_rotation_operations_waitlist_idx
  ON public.invitation_rotation_operations (waitlist_id, prepared_at DESC);

COMMENT ON TABLE public.invitation_rotation_operations IS
  'Durable admin resume-token rotation state machine: prepared -> accepted_pending_finalize -> '
  'finalized, or failed/uncertain. Remembers which replacement token to keep so a finalization that '
  'failed after provider acceptance can be resumed WITHOUT sending a second email. No FKs, no '
  'email, no plaintext token. See migration 078.';

ALTER TABLE public.invitation_rotation_operations ENABLE ROW LEVEL SECURITY;

-- REVOKE ALL FIRST. Supabase's inherited defaults grant broad table access at CREATE TABLE time.
REVOKE ALL ON public.invitation_rotation_operations FROM PUBLIC;
REVOKE ALL ON public.invitation_rotation_operations FROM anon;
REVOKE ALL ON public.invitation_rotation_operations FROM authenticated;
REVOKE ALL ON public.invitation_rotation_operations FROM service_role;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.invitation_rotation_operations
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.invitation_rotation_operations TO service_role;

-- ── BEGIN: prepare-or-converge, atomically ────────────────────────────────────────────────────
-- Mints the replacement token row AND the operation row in one transaction, or — if an operation is
-- already active for this invitation — returns that one and creates nothing. Concurrent admins
-- therefore converge on a single operation and a single provider call; the loser's plaintext token
-- is simply discarded by the caller, never sent.
CREATE OR REPLACE FUNCTION public.begin_resume_rotation(
  p_waitlist_id    uuid,
  p_auth_user_id   uuid,
  p_token_sha256   bytea
) RETURNS TABLE (
  -- OUT names are prefixed. A plain `state` here would be a PL/pgSQL OUT variable that shadows the
  -- column of the same name, and every reference inside the body becomes ambiguous — PostgreSQL
  -- refuses to run it rather than guessing.
  out_operation_id uuid, out_replacement_token_id uuid, out_event_key text, out_state text,
  out_delivery_id uuid, out_created boolean
)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  op  public.invitation_rotation_operations%ROWTYPE;
  v_token_id uuid;
  v_key text;
BEGIN
  IF p_waitlist_id IS NULL OR p_auth_user_id IS NULL
     OR p_token_sha256 IS NULL OR pg_catalog.octet_length(p_token_sha256) <> 32 THEN
    RAISE EXCEPTION 'waitlist id, auth user id and a 32-byte digest are all required';
  END IF;

  -- Converge on an existing active operation. Columns are alias-qualified for the same reason.
  SELECT o.* INTO op FROM public.invitation_rotation_operations o
   WHERE o.waitlist_id = p_waitlist_id
     AND o.state IN ('prepared', 'accepted_pending_finalize', 'uncertain')
   FOR UPDATE;

  IF FOUND THEN
    RETURN QUERY SELECT op.id, op.replacement_token_id, op.event_key, op.state, op.delivery_id, false;
    RETURN;
  END IF;

  INSERT INTO public.invitation_resume_tokens (waitlist_id, auth_user_id, token_sha256)
  VALUES (p_waitlist_id, p_auth_user_id, p_token_sha256)
  RETURNING id INTO v_token_id;

  v_key := 'rot:' || p_waitlist_id::text || ':' || v_token_id::text;

  INSERT INTO public.invitation_rotation_operations
    (waitlist_id, auth_user_id, replacement_token_id, event_key, state)
  VALUES (p_waitlist_id, p_auth_user_id, v_token_id, v_key, 'prepared')
  RETURNING * INTO op;

  RETURN QUERY SELECT op.id, op.replacement_token_id, op.event_key, op.state, op.delivery_id, true;
END;
$fn$;

-- ── Record the provider outcome BEFORE finalization ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_resume_rotation_outcome(
  p_operation_id uuid,
  p_state        text,
  p_delivery_id  uuid  DEFAULT NULL,
  p_error_class  text  DEFAULT NULL
) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_state text;
BEGIN
  IF p_state NOT IN ('accepted_pending_finalize', 'failed', 'uncertain') THEN
    RAISE EXCEPTION 'invalid outcome state';
  END IF;

  UPDATE public.invitation_rotation_operations o
     SET state        = p_state,
         delivery_id  = COALESCE(p_delivery_id, o.delivery_id),
         error_class  = p_error_class,
         accepted_at  = CASE WHEN p_state = 'accepted_pending_finalize' THEN pg_catalog.now() ELSE o.accepted_at END,
         failed_at    = CASE WHEN p_state = 'failed' THEN pg_catalog.now() ELSE o.failed_at END
   WHERE o.id = p_operation_id
     -- A finalized operation is terminal; a late outcome must not reopen it.
     AND o.state IN ('prepared', 'accepted_pending_finalize', 'uncertain')
  RETURNING o.state INTO v_state;

  RETURN COALESCE(v_state, 'unchanged');
END;
$fn$;

REVOKE ALL ON FUNCTION public.begin_resume_rotation(uuid, uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.begin_resume_rotation(uuid, uuid, bytea) FROM anon;
REVOKE ALL ON FUNCTION public.begin_resume_rotation(uuid, uuid, bytea) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.begin_resume_rotation(uuid, uuid, bytea) TO service_role;
REVOKE ALL ON FUNCTION public.record_resume_rotation_outcome(uuid, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_resume_rotation_outcome(uuid, text, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.record_resume_rotation_outcome(uuid, text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_resume_rotation_outcome(uuid, text, uuid, text) TO service_role;

-- ═══ ROTATION FINALIZER ═════════════════════════════════════════════════════════════════════════
-- Supersedes every live resume token for an invitation EXCEPT the replacement, atomically.
--
-- ─── WHY "SUPERSEDE THEN SEND" WOULD BE WRONG ─────────────────────────────────────────────────
-- Sending email is an external call with three outcomes, not two. If the old tokens were retired
-- first and the send then failed — or worse, returned an uncertain outcome — the member would be
-- left holding only dead links, with no way to tell them so. The safe order is PREPARE (mint the
-- replacement, everything still live) → SEND → FINALIZE (retire the others) and finalize ONLY on a
-- definite provider acceptance. A failed or uncertain send leaves every prior link working, which
-- is the recoverable direction.
--
-- IDEMPOTENT: running it again after the rotation has completed supersedes nothing further, because
-- the other rows are already superseded. It returns how many it retired, so a caller can tell a
-- real rotation from a replay without needing a separate flag.
CREATE OR REPLACE FUNCTION public.finalize_resume_rotation(p_operation_id uuid)
  RETURNS TABLE (out_state text, out_retired integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  op  public.invitation_rotation_operations%ROWTYPE;
  v_n integer;
BEGIN
  SELECT o.* INTO op FROM public.invitation_rotation_operations o
   WHERE o.id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown rotation operation';
  END IF;

  -- Idempotent: finalizing an already-finalized operation retires nothing further and is not an
  -- error. This is what makes a resumed retry safe.
  IF op.state = 'finalized' THEN
    RETURN QUERY SELECT 'finalized'::text, 0; RETURN;
  END IF;

  -- Finalization is permitted ONLY after the provider definitely accepted. Retiring a member's
  -- working links on the strength of a send that may not have happened is the failure mode the
  -- whole prepare/send/finalize order exists to prevent.
  IF op.state <> 'accepted_pending_finalize' THEN
    RETURN QUERY SELECT op.state, 0; RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.invitation_resume_tokens
     WHERE id = op.replacement_token_id AND waitlist_id = op.waitlist_id
       AND revoked_at IS NULL AND superseded_at IS NULL
  ) THEN
    RAISE EXCEPTION 'replacement token is not a live token for this invitation';
  END IF;

  UPDATE public.invitation_resume_tokens
     SET superseded_at = pg_catalog.now()
   WHERE waitlist_id = op.waitlist_id
     AND id <> op.replacement_token_id
     AND revoked_at IS NULL
     AND superseded_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE public.invitation_rotation_operations o
     SET state = 'finalized', finalized_at = pg_catalog.now()
   WHERE o.id = op.id;

  RETURN QUERY SELECT 'finalized'::text, v_n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.finalize_resume_rotation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_resume_rotation(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_resume_rotation(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_resume_rotation(uuid) TO service_role;

COMMENT ON FUNCTION public.finalize_resume_rotation(uuid) IS
  'Retires every live resume token for an invitation except the replacement. Called ONLY after a '
  'rotation email is definitely accepted — never on a reminder, a resend, or a resume request. '
  'Idempotent, and resumable: an operation whose finalization failed after acceptance can be '
  'completed by calling this again, with no second email. See migration 078.';

-- ═══ THE ATOMIC CLAIM ═══════════════════════════════════════════════════════════════════════════
-- Every eligibility check AND both rate-limit decisions happen inside ONE call, in one transaction,
-- under a row lock. That is what closes the TOCTOU window: a profile completed or an invitation
-- revoked between the page load and the button press is seen HERE, not at page render.
--
-- ─── ORDERING IS A SECURITY PROPERTY, NOT A STYLE CHOICE ──────────────────────────────────────
-- An earlier draft incremented the GLOBAL bucket first, "so a flood cannot be used to probe which
-- tokens exist by timing". That reasoning was wrong in the direction that matters: it meant anyone
-- posting random 32-byte values could exhaust the global ceiling and deny the endpoint to every
-- legitimate holder, without possessing a single valid token. Cheap, unauthenticated, total.
--
-- The order below is therefore:
--   1. shape        — reject anything that is not a 32-byte digest
--   2. resolve      — lock the token row; unknown tokens stop here, costing nothing global
--   3. eligibility  — live, exactly 'invited', identity still bound, incomplete, not suppressed
--   4. per-token    — the holder's own allowance
--   5. global       — only an otherwise-valid, per-token-allowed request may touch this counter
--   6. commit       — consume the per-token allowance ONLY after the global check also passes
--
-- Step 6 is the subtle one: if the global ceiling is reached, the per-token allowance must NOT be
-- consumed, or a global flood would silently burn legitimate holders' quotas as collateral.
--
-- The timing side-channel the old order tried to prevent is not worth buying with a denial of
-- service, and it is not really available anyway: every path returns the same generic response and
-- does comparable work.
CREATE OR REPLACE FUNCTION public.claim_invitation_resume_request(
  p_token_sha256   bytea,
  p_max_per_window integer DEFAULT 3,
  p_window_minutes integer DEFAULT 60,
  p_global_per_min integer DEFAULT 30
) RETURNS TABLE (status text, out_waitlist_id uuid, out_auth_user_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  t           public.invitation_resume_tokens%ROWTYPE;
  v_bucket    timestamptz := pg_catalog.date_trunc('minute', pg_catalog.now());
  v_global    integer;
  v_complete  boolean;
  v_wstatus   text;
  v_email     text;
  v_authn     integer;
  v_authid    uuid;
  v_supp      integer;
  v_allowed   boolean;
  v_reset     boolean;
BEGIN
  -- 1. SHAPE.
  IF p_token_sha256 IS NULL OR pg_catalog.octet_length(p_token_sha256) <> 32 THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;

  -- 2. RESOLVE. An unknown token stops here having touched no counter at all.
  SELECT * INTO t FROM public.invitation_resume_tokens
   WHERE token_sha256 = p_token_sha256
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  IF t.revoked_at IS NOT NULL OR t.superseded_at IS NOT NULL THEN
    RETURN QUERY SELECT 'revoked'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;

  -- 3. ELIGIBILITY, re-derived from live state on every request.
  SELECT w.status, pg_catalog.lower(pg_catalog.btrim(w.email))
    INTO v_wstatus, v_email
    FROM public.waitlist w WHERE w.id = t.waitlist_id;

  -- A deleted invitation resolves to nothing. No foreign key was needed to achieve that.
  IF v_wstatus IS NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;

  -- EXACTLY 'invited'. Not "anything except revoked or declined" — a status this code has never
  -- seen ('pending', 'approved', or one added later) must fail closed, not be waved through by an
  -- inverted test that only knows the two failures someone happened to think of.
  IF v_wstatus <> 'invited' THEN
    RETURN QUERY SELECT 'revoked'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;

  -- IDENTITY BINDING. Resolve the CURRENT unique auth user and require it to be the one bound when
  -- the token was issued. This rejects an ambiguous address, an identity deleted after issuance,
  -- and — the case a plain existence check would miss entirely — an account deleted and RECREATED
  -- at the same address, which is a different person as far as the database is concerned.
  SELECT li.identity_count, li.auth_user_id INTO v_authn, v_authid
    FROM public.lookup_auth_identity(v_email) li;

  IF v_authn <> 1 OR v_authid IS NULL THEN
    RETURN QUERY SELECT 'ambiguous'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  IF v_authid <> t.auth_user_id THEN
    RETURN QUERY SELECT 'identity_changed'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;

  -- TERMINAL: completion, checked against the RESOLVED CURRENT uuid.
  SELECT p.profile_complete INTO v_complete FROM public.profiles p WHERE p.id = v_authid;
  IF v_complete IS TRUE THEN
    RETURN QUERY SELECT 'completed'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;

  -- SUPPRESSION. Deliberately ANY historical bounce/block/complaint, not merely the latest state:
  -- a complaint is a standing instruction from the recipient, and a later 'delivered' row does not
  -- withdraw it. This is stated here because the semantics must not be described as "latest" while
  -- being implemented as "any".
  SELECT pg_catalog.count(*) INTO v_supp FROM public.invitation_deliveries d
   WHERE pg_catalog.lower(pg_catalog.btrim(d.recipient_email)) = v_email
     AND d.status IN ('bounced', 'blocked', 'complained');
  IF v_supp > 0 THEN
    RETURN QUERY SELECT 'suppressed'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;

  -- 4. PER-TOKEN ALLOWANCE. Decided but NOT yet consumed.
  v_reset := t.window_started_at IS NULL
             OR t.window_started_at < pg_catalog.now() - pg_catalog.make_interval(mins => p_window_minutes);
  v_allowed := v_reset OR t.window_count < p_max_per_window;
  IF NOT v_allowed THEN
    RETURN QUERY SELECT 'rate_limited'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;

  -- 5. GLOBAL. Reached only by an otherwise-valid, per-token-allowed request, so random tokens can
  --    never move this counter.
  INSERT INTO public.invitation_resume_rate (minute_bucket, request_count)
  VALUES (v_bucket, 1)
  ON CONFLICT (minute_bucket) DO UPDATE
    SET request_count = public.invitation_resume_rate.request_count + 1
  RETURNING request_count INTO v_global;

  IF v_global > p_global_per_min THEN
    -- The per-token allowance is deliberately NOT consumed: a global flood must not burn a
    -- legitimate holder's own quota as collateral damage.
    RETURN QUERY SELECT 'rate_limited'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;

  -- 6. COMMIT the per-token consumption, now that both limits have passed.
  IF v_reset THEN
    UPDATE public.invitation_resume_tokens
       SET window_started_at = pg_catalog.now(), window_count = 1,
           request_count = request_count + 1, last_requested_at = pg_catalog.now()
     WHERE id = t.id;
  ELSE
    UPDATE public.invitation_resume_tokens
       SET window_count = window_count + 1,
           request_count = request_count + 1, last_requested_at = pg_catalog.now()
     WHERE id = t.id;
  END IF;

  -- A successful request does NOT consume, rotate or revoke the token: the same reminder link must
  -- keep working after the emailed sign-in link expires.
  RETURN QUERY SELECT 'ok'::text, t.waitlist_id, v_authid;
END;
$fn$;

REVOKE ALL ON FUNCTION public.claim_invitation_resume_request(bytea, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_invitation_resume_request(bytea, integer, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_invitation_resume_request(bytea, integer, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_invitation_resume_request(bytea, integer, integer, integer) TO service_role;

COMMIT;
