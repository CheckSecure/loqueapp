-- Optional "relationship" context on a member nomination.
--
-- Adds a nullable free-text column to the existing referrals table so a referring
-- member can (optionally) note how they know the person they are recommending
-- (e.g. "former colleague", "client", "opposing counsel"). Purely additive: the
-- existing submit flow, dedupe, admin review, and invite path are unchanged; the
-- field is written when provided and left NULL otherwise.
--
-- Backward compatible + idempotent (ADD COLUMN IF NOT EXISTS). Until applied, the
-- referrals/submit route fails open — it retries the insert WITHOUT this column on
-- an "undefined column" error, so nominations keep working before and after the
-- migration; the relationship value is simply dropped until the column exists.

ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS relationship text;

COMMENT ON COLUMN public.referrals.relationship IS
  'Optional: the referring member''s relationship to the recommended person (free text). NULL when not provided. Additive to the existing nomination flow.';
