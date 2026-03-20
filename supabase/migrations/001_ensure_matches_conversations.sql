-- Ensure matches table exists
CREATE TABLE IF NOT EXISTS matches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id   uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_b_id   uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT matches_unique_pair UNIQUE (user_a_id, user_b_id)
);

-- Ensure match_id column exists on conversations
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS match_id uuid REFERENCES matches(id) ON DELETE SET NULL;

-- Index for fast lookup by match_id
CREATE INDEX IF NOT EXISTS conversations_match_id_idx ON conversations (match_id);
