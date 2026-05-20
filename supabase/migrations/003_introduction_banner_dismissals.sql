CREATE TABLE IF NOT EXISTS introduction_banner_dismissals (
  user_id       uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  batch_id      uuid        NOT NULL REFERENCES introduction_batches(id) ON DELETE CASCADE,
  dismissed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, batch_id)
);

ALTER TABLE introduction_banner_dismissals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own banner dismissals"
  ON introduction_banner_dismissals
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own banner dismissals"
  ON introduction_banner_dismissals
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);
