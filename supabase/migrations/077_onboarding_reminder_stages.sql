-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 077 — STAGED ONBOARDING REMINDERS + PROSPECTIVE ENROLLMENT BOUNDARY
--
-- WHY. The existing activation-reminder cron disqualifies anyone with last_sign_in_at set, so the
-- 18 people who signed in and stalled mid-onboarding can never be reminded again. It also uses a
-- 23-48h WINDOW for stage 1 and requires stage 1 before stage 2, so a single missed run strands a
-- person permanently. Production shows 117 broadly eligible incomplete invitees, 50 of them older
-- than 30 days. This migration provides the durable per-stage claim the corrected design needs.
--
-- ─── PROSPECTIVE ENROLLMENT, AND WHY IT IS A COLUMN AND NOT A DATE CONSTANT ────────────────────
-- Approved policy: the 117 historical invitees must NOT receive automatic reminders. Enrollment is
-- therefore EXPLICIT — waitlist.reminder_enrollment_at is stamped by the invite path at send time,
-- from this deployment onward. NULL means "not enrolled", which is every existing row.
--
-- There is NO BACKFILL, deliberately. A date constant ("enrolled if invited_at > X") would have
-- looked equivalent and been far more dangerous: any later correction to invited_at, any re-invite,
-- or any clock assumption would silently sweep historical people into an automatic send. A column
-- that is only ever written forward cannot do that. The 117 stay out because nothing ever stamps
-- them, not because an inequality currently happens to exclude them.
--
-- ─── STAGE CLAIMS REUSE invitation_deliveries, NOT reminder_deliveries ────────────────────────
-- reminder_deliveries.member_id is `uuid NOT NULL REFERENCES public.profiles(id)` (migration 065).
-- 118 of these people have NO profile row, so that table cannot represent them at all.
-- invitation_deliveries (049) was built for exactly this cohort: waitlist_id with NO foreign key,
-- auth_user_id nullable, recipient_email normalized. Its pre-send atomic claim is the existing,
-- proven concurrency primitive, so staged reminders reuse it rather than inventing a second one.
--
-- ─── THE CLAIM INDEX IS WHY EACH STAGE IS ITS OWN PURPOSE ─────────────────────────────────────
-- invitation_deliveries_active_claim_uniq is UNIQUE (waitlist_id, purpose) WHERE status IN
-- ('claimed','accepted','deferred'). One purpose therefore permits ONE active attempt per person,
-- ever. Three stages need three purposes, or stage 2 could never be claimed after stage 1. That is
-- also exactly the dedupe the design requires: the unique index IS the per-stage deduplication, and
-- it is concurrency-safe by construction — a second worker's INSERT raises 23505 and it skips.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Prospective enrollment marker ──────────────────────────────────────────────────────────
ALTER TABLE public.waitlist
  ADD COLUMN IF NOT EXISTS reminder_enrollment_at timestamptz NULL;

COMMENT ON COLUMN public.waitlist.reminder_enrollment_at IS
  'Stamped by the invite path when an invitation is sent, from migration 077 onward. NULL = not '
  'enrolled in automatic onboarding reminders (every pre-077 row). Never backfilled: the historical '
  'cohort is excluded because nothing stamps them, not because of a date comparison.';

-- Partial index: the reminder worker only ever scans enrolled rows.
CREATE INDEX IF NOT EXISTS waitlist_reminder_enrollment_idx
  ON public.waitlist (reminder_enrollment_at, invited_at)
  WHERE reminder_enrollment_at IS NOT NULL;

-- ── 2. Staged reminder purposes ───────────────────────────────────────────────────────────────
-- The existing values are preserved EXACTLY. 'reminder' is retained although nothing writes it —
-- removing a value from a CHECK that historical rows might use would be a data-loss risk for no
-- benefit.
ALTER TABLE public.invitation_deliveries
  DROP CONSTRAINT IF EXISTS invitation_deliveries_purpose_check;

ALTER TABLE public.invitation_deliveries
  ADD CONSTRAINT invitation_deliveries_purpose_check
  CHECK (purpose IN (
    'first_invite',
    'access_resend',
    'reminder',                 -- legacy value, retained; unused by code
    'onboarding_reminder_1',    -- >= 24h after invitation
    'onboarding_reminder_2',    -- >= 3 days
    'onboarding_reminder_3',    -- >= 7 days, terminal
    'onboarding_catchup',       -- admin-only historical campaign; never automatic
    'resume_access',            -- a member pressed "Continue setting up"; MAY recur, see below
    'resume_rotation'           -- explicit admin rotation; concurrency is held elsewhere, see below
  ));

-- ─── WHY resume_access AND resume_rotation ROWS CARRY waitlist_id = NULL ───────────────────────
-- Migration 049's claim index is UNIQUE (waitlist_id, purpose) WHERE status IN
-- ('claimed','accepted','deferred'). It is applied in production and cannot be relaxed here.
--
-- For a per-stage reminder that index IS the dedupe and is exactly right. For these two purposes it
-- would be a permanent lock:
--   • resume_access is SUPPOSED to recur. The design allows a member three fresh-link requests an
--     hour; the rate limiter enforces that. Under the 049 index the FIRST accepted send would block
--     every later request for the life of the row, and the member would press the button, get the
--     generic success message, and receive nothing — the same silent failure this whole pass exists
--     to eliminate.
--   • resume_rotation may legitimately happen more than once over an invitation's life. Its
--     concurrency boundary is public.invitation_rotation_operations (migration 078), which holds at
--     most one ACTIVE operation per invitation — a boundary that can be released on completion,
--     which a delivery row in a terminal 'accepted' state cannot.
--
-- Setting waitlist_id NULL takes these rows out of that index. Linkage is NOT lost: auth_user_id and
-- the normalized recipient_email are both recorded, and the auth id is unique by construction on
-- every path that writes them.
CREATE INDEX IF NOT EXISTS invitation_deliveries_resume_purposes_idx
  ON public.invitation_deliveries (auth_user_id, purpose, attempted_at DESC)
  WHERE purpose IN ('resume_access', 'resume_rotation');

-- ── 3. THE STAGE-CONSUMING STATE MACHINE ──────────────────────────────────────────────────────
-- The pre-existing claim index from 049 is UNIQUE (waitlist_id, purpose) WHERE status IN
-- ('claimed','accepted','deferred'). That set is WRONG for reminder stages in two directions:
--
--   • 'delivered' is ABSENT, so a delivered reminder would permit a second claim of the same stage
--     and the member would be emailed twice. For first_invite/access_resend the row is reconciled
--     by the webhook while still 'accepted', so the gap never showed; a staged reminder is exactly
--     the case where it would.
--   • 'bounced' / 'blocked' / 'complained' are absent too. Those mean the provider DID take the
--     message and then rejected or reported it. Re-sending into a suppressed address is the last
--     thing we should do, so they must consume the stage as well.
--
-- 'failed' is the ONLY non-consuming status, and only because it means the attempt died BEFORE the
-- provider was called — no message exists, so a retry cannot duplicate one. That is the whole
-- retry contract, stated as a predicate rather than as a convention someone must remember.
--
-- An UNCERTAIN provider outcome deliberately leaves the row 'claimed', which consumes the stage.
-- Nothing is retried under a new key with a regenerated link, because the same idempotency key with
-- a different payload is a 409 and a different key is a double send.
--
-- This is an ADDITIONAL index rather than an edit to 049's: that one is applied in production and
-- governs first_invite/access_resend, whose semantics are not changing. Both apply to onboarding
-- purposes, and the stricter one decides.
CREATE UNIQUE INDEX IF NOT EXISTS invitation_deliveries_onboarding_stage_uniq
  ON public.invitation_deliveries (waitlist_id, purpose)
  WHERE waitlist_id IS NOT NULL
    AND purpose IN ('onboarding_reminder_1', 'onboarding_reminder_2',
                    'onboarding_reminder_3', 'onboarding_catchup')
    AND status <> 'failed';

COMMENT ON INDEX public.invitation_deliveries_onboarding_stage_uniq IS
  'One non-failed attempt per (invitation, reminder stage). Every status except ''failed'' consumes '
  'the stage; ''failed'' means the attempt died before the provider was called, so it is the only '
  'retryable one. See migration 077.';

-- ── 4. DISPATCH STATE: telling "not sent yet" apart from "we do not know" ─────────────────────
-- status = 'claimed' currently means two completely different things:
--   • the row was claimed and the provider has NOT been called yet, and
--   • the provider WAS called and returned an unknown outcome.
-- The first is safe to retire and retry — no message exists. The second must never be retried under
-- a new idempotency key, because a new key with a regenerated link is exactly how one uncertain send
-- becomes two delivered emails. Collapsing them into one status made "has enough time passed?" the
-- deciding question, which is not a safe basis for either answer.
--
-- CLOSED VOCABULARY. No raw provider text ever lands here.
ALTER TABLE public.invitation_deliveries
  ADD COLUMN IF NOT EXISTS dispatch_state text NULL;

ALTER TABLE public.invitation_deliveries
  DROP CONSTRAINT IF EXISTS invitation_deliveries_dispatch_state_check;

ALTER TABLE public.invitation_deliveries
  ADD CONSTRAINT invitation_deliveries_dispatch_state_check
  CHECK (dispatch_state IS NULL OR dispatch_state IN (
    'pending',       -- claimed; the provider has NOT been called. The ONLY safely retryable state.
    'dispatching',   -- the provider call is BEGINNING or may already have happened, and no
                     -- definitive outcome has been durably recorded. NEVER auto-retryable.
    'dispatched',    -- the provider was called and answered definitively (accepted or refused)
    'uncertain'      -- the provider answered with an UNKNOWN outcome. NEVER auto-retryable.
  ));

-- ─── WHY 'dispatching' HAD TO EXIST ───────────────────────────────────────────────────────────
-- Without it there was a crash window with no safe reading. The row stayed 'pending' across the
-- entire provider call, so a process that died mid-call — or after the provider accepted but before
-- the post-call update landed — left a row indistinguishable from one where nothing had been
-- attempted. The lease then retired it as stale_pre_dispatch and permitted a SECOND send under a
-- new idempotency key. One crash, two emails.
--
-- The marker is written BEFORE the provider call and requires exactly one row to transition, so the
-- moment any dispatch could have occurred the row already says so. It is also the SAFE RESTING
-- STATE for every post-call bookkeeping failure: if the accepted/failed/uncertain update itself
-- fails, the row is left saying "a dispatch may have happened", which is the only honest reading.
--
-- 'dispatching' and 'uncertain' are both permanently non-auto-retryable. Neither expires. Only
-- durable webhook evidence or explicit admin review resolves them.

COMMENT ON COLUMN public.invitation_deliveries.dispatch_state IS
  'Whether the provider has been called for this attempt. NULL on pre-077 rows. ''uncertain'' is '
  'terminal for automatic purposes: only webhook evidence or explicit admin review may resolve it. '
  'See migration 077.';

CREATE INDEX IF NOT EXISTS invitation_deliveries_resume_dispatch_idx
  ON public.invitation_deliveries (auth_user_id, purpose, status, dispatch_state, attempted_at DESC)
  WHERE purpose = 'resume_access';

-- ── 5. Privileges ─────────────────────────────────────────────────────────────────────────────
-- A GRANT is additive; only REVOKE removes. Supabase's ALTER DEFAULT PRIVILEGES means a table can
-- hold verbs nobody granted. These tables already exist, so their ACLs are asserted rather than
-- created — restating them costs nothing and prevents drift.
REVOKE ALL ON public.invitation_deliveries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.invitation_deliveries TO service_role;

COMMIT;
