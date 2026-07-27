-- Clickwrap legal acceptance tracking.
--
-- Records each member's affirmative acceptance of the Terms of Service and the
-- Privacy Policy: which VERSION they accepted (monotonic integer from
-- lib/legal/terms.ts) and WHEN, plus the request IP when available. The app gates
-- platform access on these: a member whose accepted version is below the current
-- constant (or null — never accepted) must re-accept before continuing
-- (see needsReacceptance() and app/legal/accept).
--
-- ORDERING: the dashboard access gate and /api/legal/accept read/write these
-- columns, so this migration MUST be applied BEFORE deploying the code that uses
-- them. While unapplied, the acceptance gate self-disables (compatibility mode)
-- so the app keeps working — see lib/db/migrationHealth.ts (025 entry).
--
-- Idempotent + additive: ADD COLUMN IF NOT EXISTS, all nullable. Every existing
-- profile starts with NULL accepted versions, which correctly means "must accept
-- the current Terms & Privacy on next visit."

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS terms_version_accepted   integer,
  ADD COLUMN IF NOT EXISTS terms_accepted_at        timestamptz,
  ADD COLUMN IF NOT EXISTS privacy_version_accepted integer,
  ADD COLUMN IF NOT EXISTS privacy_accepted_at      timestamptz,
  ADD COLUMN IF NOT EXISTS legal_accepted_ip        text;

COMMENT ON COLUMN public.profiles.terms_version_accepted IS
  'Integer Terms of Service version the member affirmatively accepted (lib/legal/terms.ts TERMS_VERSION). NULL = never accepted.';
COMMENT ON COLUMN public.profiles.privacy_version_accepted IS
  'Integer Privacy Policy version the member affirmatively accepted (lib/legal/terms.ts PRIVACY_VERSION). NULL = never accepted.';
COMMENT ON COLUMN public.profiles.legal_accepted_ip IS
  'Best-effort request IP captured at the most recent legal acceptance, when available. Audit only.';
