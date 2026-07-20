-- Durable failure records for the activation-reminder lifecycle emails.
--
-- reminder 1 / reminder 2 previously recorded only a *_sent_at timestamp and
-- logged failures to the console (not queryable). The launch-announcement and
-- first-matching campaigns already have paired *_error columns; these bring the
-- two invite reminders in line so a failed send is durably recorded and the
-- recipient stays eligible for a later intentional retry.
--
-- No lifecycle "cohort/generation/status" column is added — lifecycle state is
-- computed from existing timestamps + profiles.profile_complete.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS — safe to run more than once.

ALTER TABLE waitlist
  ADD COLUMN IF NOT EXISTS invite_reminder_1_error text;

ALTER TABLE waitlist
  ADD COLUMN IF NOT EXISTS invite_reminder_2_error text;
