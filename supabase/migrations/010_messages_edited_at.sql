-- Message editing: allow a member to edit their own message within 60 minutes.
--
-- Adds a nullable edited_at timestamp. NULL = never edited. The application
-- writes it (alongside content) only through the guarded /api/messages/edit
-- route; created_at is never touched, so the original sent time is preserved.
--
-- No edit-history / original_content in this release (not required by the
-- product). Idempotent and additive — safe to apply anytime, no backfill.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS edited_at timestamptz;
