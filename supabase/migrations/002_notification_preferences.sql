CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id                 uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  email_new_introductions boolean     NOT NULL DEFAULT true,
  email_messages          boolean     NOT NULL DEFAULT true,
  email_meeting_updates   boolean     NOT NULL DEFAULT true,
  email_opportunities     boolean     NOT NULL DEFAULT true,
  email_product_updates   boolean     NOT NULL DEFAULT true,
  email_daily_digest      boolean     NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own notification preferences"
  ON notification_preferences
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own notification preferences"
  ON notification_preferences
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own notification preferences"
  ON notification_preferences
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Preserve existing opt-outs: users who previously turned off the all-or-nothing
-- "email notifications" toggle had only the daily digest configurable, so port
-- that choice into the new email_daily_digest column. Users with the default
-- (true) get no row — the check function treats missing rows as "all enabled".
INSERT INTO notification_preferences (user_id, email_daily_digest)
SELECT id, false
FROM profiles
WHERE email_notifications_enabled = false
ON CONFLICT (user_id) DO UPDATE
SET email_daily_digest = false,
    updated_at = now();
