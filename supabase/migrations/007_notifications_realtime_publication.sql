-- Ensure the notifications table is published to Supabase Realtime so the
-- NotificationBell receives INSERT events live (unread count updates without a
-- page refresh). The bell subscribes to INSERTs filtered to the authenticated
-- user (user_id=eq.<uuid>) and RLS scopes row visibility, so publishing the
-- table cannot leak another user's notifications.
--
-- Fully idempotent and safe to run repeatedly:
--   * no-op if the supabase_realtime publication does not exist
--   * no-op if the table is already a member of the publication
-- so it will not fail whether or not notifications is already published.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;
END$$;
