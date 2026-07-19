-- One-time "first matching round" reminder campaign
-- (campaign id: first-matching-round-reminder-2026-07-21).
--
-- Per-recipient idempotency columns, mirroring the launch-announcement pattern
-- (launch_announcement_sent_at / launch_announcement_email_error). The send
-- marks first_matching_reminder_sent_at the instant a recipient's email is
-- accepted by the provider; the cohort query excludes anyone already marked, so
-- a re-trigger or a mid-run timeout can never double-send.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS — safe to run more than once.

ALTER TABLE waitlist
  ADD COLUMN IF NOT EXISTS first_matching_reminder_sent_at timestamptz;

ALTER TABLE waitlist
  ADD COLUMN IF NOT EXISTS first_matching_reminder_error text;
