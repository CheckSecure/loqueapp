-- Performance: conversation-list load (Messages tab) and active-thread load.
--
-- The messages table had NO index (only conversations_match_id_idx existed), so
-- every "latest message for conversation" / "unread for conversation" / "thread
-- history" lookup was a sequential scan. This index backs the dominant access
-- pattern — messages filtered by conversation_id and ordered by created_at.
--
-- Idempotent: CREATE INDEX IF NOT EXISTS / CREATE OR REPLACE FUNCTION.

CREATE INDEX IF NOT EXISTS messages_conversation_id_created_at_idx
  ON messages (conversation_id, created_at DESC);

-- Latest message per conversation in a single round-trip (DISTINCT ON), used by
-- the conversation-list API. Bounded to one row per requested conversation.
-- Called via the service-role admin client; authorization is enforced in the
-- route (only conversations the caller is a participant of are passed in).
CREATE OR REPLACE FUNCTION latest_messages_for_conversations(conv_ids uuid[])
RETURNS TABLE (
  id uuid,
  conversation_id uuid,
  content text,
  sender_id uuid,
  is_system boolean,
  created_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT ON (m.conversation_id)
    m.id, m.conversation_id, m.content, m.sender_id, m.is_system, m.created_at
  FROM messages m
  WHERE m.conversation_id = ANY(conv_ids)
  ORDER BY m.conversation_id, m.created_at DESC
$$;
