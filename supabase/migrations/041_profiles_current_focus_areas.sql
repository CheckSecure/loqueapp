-- 041 — Current focus areas (Phase B)
--
-- Optional, member-editable list of the technologies, policy areas, industries,
-- and subjects that are especially relevant to a member RIGHT NOW. Distinct from
-- enduring `expertise` and personal `interests`. A soft, timely matching signal.
--
-- Additive · idempotent · non-destructive · no backfill. Stored as a normalized
-- JSON string array (e.g. ["Nuclear energy","Energy policy"]). Never part of
-- profile-completion; an empty list is the default and is fully valid.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS current_focus_areas jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.profiles.current_focus_areas IS
  'Optional, member-editable normalized string[] of current focus areas (topics/technologies/industries/policy). Soft matching signal only; never gates profile completion, onboarding, or eligibility. Default [].';
