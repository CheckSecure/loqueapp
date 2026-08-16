-- 058 — A3 CONTRACT: revoke authenticated/anon browser SELECT on the base public.profiles table.
--
-- APPLY ONLY AFTER migration 057 AND the refactored app code are deployed and verified. By this point
-- every member-facing read goes through public_profiles (discovery-scoped, safe columns) or
-- get_my_profile() (self), and every admin/matching/internal read is service_role. Revoking here closes
-- direct console access to another member's raw profile row (email, phone, tier/billing, internal scores,
-- moderation/security fields, private timestamps) and to the full base row.
--
-- Both the public_profiles view (security_invoker = off) and can_discover_profile / get_my_profile
-- (SECURITY DEFINER) run as the OWNER, so they KEEP working after this revoke. service_role bypasses RLS
-- and retains full access (matching, cron, admin, server routes). Additive/idempotent; no data changes.
-- Does NOT touch migration 048.

REVOKE SELECT ON TABLE public.profiles FROM PUBLIC, anon, authenticated;

-- Preserve service_role (explicit + idempotent; service_role also bypasses RLS regardless).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO service_role;

-- NOTE: the relationship-scoped RLS SELECT policy `profiles_relationship_read` (migration 043) becomes
-- moot once the SELECT privilege is revoked (a policy filters a privilege the role no longer holds). It
-- is intentionally LEFT IN PLACE so that if base SELECT is ever re-granted, discovery scoping is still
-- enforced. INSERT/UPDATE remain revoked from browser roles by migration 055.
