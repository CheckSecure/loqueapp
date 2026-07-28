-- Persist the meeting's scheduling timezone for correct email display.
--
-- scheduled_at stays the single source of truth in UTC (unchanged). This adds the
-- IANA timezone (e.g. America/New_York) the meeting was scheduled in, captured from
-- the scheduler's browser, so later emails — notably the acceptance/confirmation
-- email, which has no browser context of its own — can show the correct local time
-- (with abbreviation) alongside UTC via formatMeetingTimes(scheduled_at, scheduled_timezone).
--
-- Nullable and additive: existing meetings keep NULL and correctly fall back to the
-- UTC-only display. Values are written ONLY by the app (create/reschedule) after
-- validating a real IANA zone; there is NO default and NO backfill — existing rows
-- are never guessed.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Production-safe: additive, nullable, no
-- table rewrite, no destructive operation.

ALTER TABLE public.meetings
  ADD COLUMN IF NOT EXISTS scheduled_timezone text;

COMMENT ON COLUMN public.meetings.scheduled_timezone IS
  'IANA timezone (e.g. America/New_York) the meeting was scheduled in, captured from the scheduler''s browser. Display-only, used for local-time formatting in emails; scheduled_at remains the canonical UTC time. NULL for legacy rows, which fall back to UTC-only display.';
