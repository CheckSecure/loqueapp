ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS founding_member_email_sent_at timestamptz;
