-- Per-member dismissal for the Introductions-page "Improve your recommendations" prompt.
--
-- Adds a single nullable timestamp so a member who clicks "Not now" on the
-- Introductions guidance card is not re-nudged on every visit. Purely a UI
-- preference: it never affects matching, eligibility, recommendation generation,
-- queue behavior, or profile-completeness. A completed matching profile overrides
-- this (the card retires on its own), so a dismissed member who later completes —
-- or a member who never dismisses — is unaffected.
--
-- Additive + nullable + idempotent (ADD COLUMN IF NOT EXISTS). Until applied, the
-- Introductions page reads it fail-open (treats everyone as not-dismissed) and the
-- dismiss endpoint is best-effort, so nothing breaks pre-migration.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS intro_profile_prompt_dismissed_at timestamptz;

COMMENT ON COLUMN public.profiles.intro_profile_prompt_dismissed_at IS
  'When the member dismissed the Introductions-page "Improve your recommendations" prompt ("Not now"). NULL = not dismissed. UI-only; never affects matching or eligibility. A complete matching profile overrides this.';
