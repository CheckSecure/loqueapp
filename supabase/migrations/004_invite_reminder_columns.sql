ALTER TABLE waitlist
  ADD COLUMN IF NOT EXISTS invite_reminder_1_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS invite_reminder_2_sent_at timestamptz;
