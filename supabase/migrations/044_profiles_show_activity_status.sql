-- 044 — Presence: member opt-out for last-active status.
--
-- Adds a single additive boolean to profiles. Existing members default to VISIBLE
-- (true) so the feature works on day one, with an immediate opt-out via the settings
-- toggle ("Show when I'm active"). No backfill needed (DEFAULT applies to existing rows).
--
-- Prod-safe: additive, idempotent, non-destructive. No RLS change — presence reads flow
-- through the existing profiles_relationship_read policy (migration 043); this column is
-- only ever emitted to another member when they can already discover the profile AND
-- show_activity_status is not false (enforced in the query/route layer).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS show_activity_status boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.profiles.show_activity_status IS
  'When false, other members never see this member''s online/last-active status. The member still sees their own. last_active_at is still recorded for system use but not exposed socially.';
