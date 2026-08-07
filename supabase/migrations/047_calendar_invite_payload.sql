-- 047 — Durable calendar-invite payload for crash-safe / post-deletion retry.
--
-- A cancellation (METHOD:CANCEL) is claimed BEFORE the meeting row is hard-deleted. If the
-- inline provider send fails, the invite must stay retryable EVEN THOUGH the meeting row is
-- gone. Storing the fully-rendered payload (recipient, summary, ICS, method, sequence,
-- idempotency key) on the durable meeting_calendar_invites row lets a retry re-send the
-- exact same message without ever querying the deleted meeting.
--
-- Prod-safe: additive, idempotent, non-destructive.

ALTER TABLE public.meeting_calendar_invites
  ADD COLUMN IF NOT EXISTS payload jsonb;

COMMENT ON COLUMN public.meeting_calendar_invites.payload IS
  'Fully-rendered email+ICS args captured at claim time so a failed send can be retried without the (possibly hard-deleted) meeting row. Contains no secrets/tokens — only the calendar event already delivered to attendees.';
