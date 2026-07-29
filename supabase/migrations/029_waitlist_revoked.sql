-- Admin "Revoke Invite" — terminal invitation state.
--
-- Lets an admin revoke an invitation BEFORE the member has activated (mistaken
-- invite, duplicate, or requested removal). Revoking sets waitlist.status =
-- 'revoked' (a NEW terminal string — waitlist.status is app-controlled free text,
-- like 'invited'/'approved'/'declined'/'contacted', with no CHECK to alter) and
-- stamps revoked_at. It does NOT delete the row, so all history/timestamps
-- (created_at, invited_at, referral_source, reminder timestamps) are preserved for
-- audit. The bare auth account (no profile yet) is removed by the app so the temp
-- password can no longer sign in.
--
-- 'revoked' is automatically excluded from every invite/reminder path, which all
-- gate on status = 'invited' (activation-reminders, first-matching-reminder) or
-- require pending/approved (launch-announcement) — no code there needs changing.
--
-- Additive + nullable + idempotent: ADD COLUMN IF NOT EXISTS. Existing rows keep
-- NULL. Production-safe: no rewrite, no destructive operation.

ALTER TABLE public.waitlist
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

COMMENT ON COLUMN public.waitlist.revoked_at IS
  'When an admin revoked this invitation (status set to ''revoked''). NULL for rows that were never revoked. Terminal state — a revoked invitation cannot activate and receives no further invite/reminder emails.';
