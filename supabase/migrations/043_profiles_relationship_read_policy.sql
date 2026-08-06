-- 043 — profiles relationship-scoped read policy (Privacy & Discoverability A2)
--
-- Replaces the permissive `profiles_authenticated_read` (USING auth.uid() IS NOT
-- NULL), which let ANY authenticated member SELECT the entire profiles table from
-- the browser (directory enumeration).
--
-- IMPLEMENTATION NOTE (why a SECURITY DEFINER function, not an inline EXISTS):
--   A policy's subqueries are evaluated AS THE QUERYING (authenticated) ROLE and
--   are THEMSELVES subject to the referenced tables' RLS + require that role to
--   hold SELECT on them. matches / intro_requests / blocked_users have NO grant or
--   RLS established by any migration (unknown/out-of-band), so an inline EXISTS
--   policy could throw `permission denied for table ...` — breaking EVERY
--   authenticated profiles read — or be silently filtered by those tables' RLS,
--   making legitimate members disappear. `can_discover_profile` is SECURITY
--   DEFINER: it runs as its OWNER (the migration role, which owns the public
--   tables), so its lookups bypass RLS and don't depend on the authenticated
--   role's grants. Service-role (SUPABASE_SERVICE_ROLE_KEY) bypasses RLS entirely,
--   so matching, cron, admin, and the company page are UNAFFECTED.
--
-- VISIBILITY CONTRACT — mirror of lib/privacy/canViewerDiscoverMember.ts
-- (decideDiscoverability); keep the two in sync. A profiles row is SELECTable by
-- auth.uid() iff: self, OR (NOT blocked) AND (active non-'removed' match, OR a
-- NON-QUEUED intro that surfaced the member: member-initiated requester=viewer/
-- target=member, admin-initiated either direction, or the member's APPROVED
-- incoming interest). Status queued NEVER grants.
--
-- Idempotent · additive · preserves service-role access.

-- ── Discoverability function (SECURITY DEFINER; viewer = auth.uid(), unspoofable) ─
CREATE OR REPLACE FUNCTION public.can_discover_profile(member_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT
    auth.uid() = member_id
    OR (
      NOT EXISTS (
        SELECT 1 FROM public.blocked_users b
        WHERE (b.user_id = auth.uid() AND b.blocked_user_id = member_id)
           OR (b.user_id = member_id AND b.blocked_user_id = auth.uid())
      )
      AND (
        EXISTS (
          SELECT 1 FROM public.matches m
          WHERE m.status <> 'removed'
            AND ( (m.user_a_id = auth.uid() AND m.user_b_id = member_id)
               OR (m.user_b_id = auth.uid() AND m.user_a_id = member_id) )
        )
        OR EXISTS (
          SELECT 1 FROM public.intro_requests ir
          WHERE ir.status IN (
            'suggested','pending','approved','accepted','accepted_pending_payment',
            'admin_pending','passed','hidden','hidden_permanent','declined',
            'rejected','expired','archived'          -- mirror of DISCOVERY_GRANT_STATUSES; excludes queued
          )
          AND (
            (ir.is_admin_initiated IS NOT TRUE AND ir.requester_id = auth.uid() AND ir.target_user_id = member_id)
            OR (ir.is_admin_initiated IS TRUE AND (
                   (ir.requester_id = auth.uid() AND ir.target_user_id = member_id)
                OR (ir.requester_id = member_id AND ir.target_user_id = auth.uid())))
            OR (ir.is_admin_initiated IS NOT TRUE AND ir.requester_id = member_id
                AND ir.target_user_id = auth.uid() AND ir.status = 'approved')
          )
        )
      )
    );
$$;

-- Not callable with a spoofed viewer (no viewer param); executable only by members.
REVOKE ALL ON FUNCTION public.can_discover_profile(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.can_discover_profile(uuid) TO authenticated;

-- ── Row policy: delegate entirely to the definer function ─────────────────────
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS profiles_authenticated_read ON public.profiles;
DROP POLICY IF EXISTS profiles_relationship_read ON public.profiles;

CREATE POLICY profiles_relationship_read ON public.profiles
  FOR SELECT
  TO authenticated
  USING (public.can_discover_profile(id));

-- ── Column privacy (additive; app read-migration + REVOKE are the A3 follow-up) ─
-- NOTE: while `authenticated` still holds SELECT on public.profiles, this view does
-- NOT by itself stop sensitive-column access (a member can still select those
-- columns on a discoverable row). Full closure = migrate member-facing reads to
-- public_profiles + a self-only path for private fields, THEN revoke authenticated
-- SELECT on profiles (Phase A3). Creating the view now is harmless.
CREATE OR REPLACE VIEW public.public_profiles
  WITH (security_invoker = on) AS
  SELECT
    id, full_name, avatar_url, title, exact_job_title, company, company_id,
    role_type, seniority, location, bio, expertise, interests, purposes,
    intro_preferences, mentorship_role, open_to_mentorship,
    open_to_business_solutions, current_focus_areas, previous_roles, account_status
  FROM public.profiles;

GRANT SELECT ON public.public_profiles TO authenticated;

COMMENT ON FUNCTION public.can_discover_profile(uuid) IS
  'Relationship-scoped discoverability. SECURITY DEFINER (bypasses referenced-table RLS/grants); viewer = auth.uid(). Mirror of lib/privacy/canViewerDiscoverMember.ts.';
