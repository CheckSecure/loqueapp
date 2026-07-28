-- Version 1.0 legal grandfathering — an ACCESS EXEMPTION, NOT affirmative acceptance.
--
-- Members whose profiles ALREADY EXIST when this migration runs are exempted from
-- the clickwrap acceptance gate through the versions recorded here, so they are
-- not interrupted. This is explicitly an access exemption: it is NOT a record that
-- the member affirmatively accepted the agreements. The affirmative-acceptance
-- columns from migration 025 (terms_version_accepted / terms_accepted_at /
-- privacy_version_accepted / privacy_accepted_at) are deliberately LEFT NULL for
-- grandfathered members and are populated only when the member later clicks through
-- the acceptance flow.
--
-- EXISTING vs FUTURE members: the one-time UPDATE below stamps only rows that exist
-- at migration time. It runs inside this migration, before any new users are
-- created afterward. New profiles created later start with NULL grandfathering
-- columns and therefore MUST complete clickwrap acceptance. There is intentionally
-- NO column default, NO trigger, and NO application code that sets these columns —
-- their values originate ONLY from this migration's UPDATE, so a future user can
-- never be silently grandfathered.
--
-- RE-ACCEPTANCE ON REVISIONS: a member grandfathered THROUGH version N is exempt
-- only up to version N. When TERMS_VERSION / PRIVACY_VERSION (lib/legal/terms.ts)
-- later exceeds N, needsReacceptance() stops treating them as satisfied and they
-- must complete the clickwrap flow.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS is safe to re-run. The backfill is a
-- ONE-TIME operation meant to run once at rollout; its WHERE clause prevents
-- re-stamping rows that are already grandfathered.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS terms_grandfathered_through_version   integer,
  ADD COLUMN IF NOT EXISTS privacy_grandfathered_through_version integer,
  ADD COLUMN IF NOT EXISTS legal_grandfathered_at                timestamptz;

COMMENT ON COLUMN public.profiles.terms_grandfathered_through_version IS
  'ACCESS EXEMPTION ONLY — not affirmative acceptance. The member existed before grandfathering and is exempt from the Terms clickwrap gate through this version; re-acceptance is required once TERMS_VERSION exceeds it. Set ONLY by the grandfathering migration — never by a default, trigger, or application code.';
COMMENT ON COLUMN public.profiles.privacy_grandfathered_through_version IS
  'ACCESS EXEMPTION ONLY — not affirmative acceptance. The member existed before grandfathering and is exempt from the Privacy clickwrap gate through this version; re-acceptance is required once PRIVACY_VERSION exceeds it. Set ONLY by the grandfathering migration — never by a default, trigger, or application code.';
COMMENT ON COLUMN public.profiles.legal_grandfathered_at IS
  'When the member was granted the grandfathering access exemption. This is NOT an acceptance timestamp — affirmative acceptance, if it later happens, is recorded separately in terms_accepted_at / privacy_accepted_at.';

-- One-time backfill: exempt ONLY the profiles that exist right now, through
-- Version 1. New profiles created after this runs are NOT matched (they are
-- created with NULL grandfathering columns and must accept). Guarded so re-running
-- never re-stamps an already-grandfathered row.
UPDATE public.profiles
SET
  terms_grandfathered_through_version = 1,
  privacy_grandfathered_through_version = 1,
  legal_grandfathered_at = NOW()
WHERE terms_grandfathered_through_version IS NULL
  AND privacy_grandfathered_through_version IS NULL;
