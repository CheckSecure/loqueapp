-- 057 — A3 EXPANSION (revised per production preflight): safe public_profiles contract, explicit
-- self-only RPC, and a participant-only intro_requests policy. Adds safe read paths but does NOT revoke
-- authenticated SELECT on public.profiles (that is migration 058, applied only AFTER 057 + refactored
-- app code are deployed & verified). Additive; makes NO data changes; does NOT touch migration 048.
--
-- Preflight facts honored: public_profiles is owner=postgres, security_invoker=on, ZERO dependent DB
-- objects, and anon/authenticated hold ALL view privileges (not just SELECT) — so we DROP+recreate the
-- view with a narrower allowlist and reset grants. The intro_requests SELECT policy currently subqueries
-- profiles (would throw permission-denied once base SELECT is revoked) — replaced with participant-only.

-- ── 1) Harden discoverability: pin search_path='' (all refs already schema-qualified). Body byte-
--        identical to migration 043's visibility contract. ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.can_discover_profile(member_id uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
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
REVOKE ALL ON FUNCTION public.can_discover_profile(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_discover_profile(uuid) TO authenticated;

-- ── 2) public_profiles: DROP + recreate (0 deps) with an EXPLICIT NARROWER allowlist. ────────────────
-- security_invoker = off → runs as OWNER, so it keeps working after base SELECT is revoked (058), and
-- rows are constrained ENTIRELY by the internal can_discover_profile(id) predicate — a caller cannot
-- reach any row outside that predicate by filtering columns. security_barrier = on blocks predicate-
-- pushdown leakage. REMOVED from the previous column set: account_status (internal account-control field
-- — deactivation checks now run server-side via service_role, never exposed to other members). Still
-- exposes NO email/phone/tier/billing/scores/moderation/security fields/private or presence timestamps.
DROP VIEW IF EXISTS public.public_profiles;
CREATE VIEW public.public_profiles
  WITH (security_invoker = off, security_barrier = on) AS
  SELECT
    id, full_name, avatar_url, title, exact_job_title, company, company_id,
    role_type, seniority, location, bio, expertise, interests, purposes,
    intro_preferences, mentorship_role, open_to_mentorship,
    open_to_business_solutions, current_focus_areas, previous_roles
  FROM public.profiles
  WHERE public.can_discover_profile(id);

-- Reset ALL view privileges (preflight: anon/authenticated held ALL, not just SELECT), then grant the
-- minimum. The view is not writable by any browser-reachable role (SELECT only to authenticated).
REVOKE ALL ON TABLE public.public_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.public_profiles TO authenticated;

COMMENT ON VIEW public.public_profiles IS
  'A3 member-facing discovery contract. DEFINER view (security_invoker=off, security_barrier=on): rows constrained solely by can_discover_profile(id); explicit safe columns only (no account_status/email/phone/tier/billing/scores/moderation/security/private/presence timestamps). SELECT-only to authenticated.';

-- ── 3) get_my_profile(): SELF-only, EXPLICIT column allowlist (NOT SETOF profiles, NO SELECT *). ─────
-- Serves the self flows that run WITHOUT service_role (browser: Billing, Onboarding, email verification;
-- edge: middleware/login gate). Server components that need the full editable row read their OWN row via
-- service_role after getUser(). Takes NO argument and binds WHERE p.id = auth.uid() → cannot target
-- another user. Excludes internal scores, moderation/trust, admin/security controls, operational
-- timestamps, stripe/customer fields, presence, and any future column.
CREATE OR REPLACE FUNCTION public.get_my_profile()
  RETURNS TABLE (
    id uuid,
    full_name text,
    title text,
    exact_job_title text,
    company text,
    bio text,
    location text,
    role_type text,
    seniority text,
    expertise text,            -- production schema: profiles.expertise is text (NOT text[])
    interests text[],
    intro_preferences text[],
    purposes text[],
    profile_complete boolean,
    onboarding_step integer,
    email_verified boolean,
    password_reset_required boolean,
    subscription_tier text,
    current_period_end timestamptz,
    is_founding_member boolean,
    founding_member_expires_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT
    p.id, p.full_name, p.title, p.exact_job_title, p.company, p.bio, p.location,
    p.role_type, p.seniority, p.expertise, p.interests, p.intro_preferences, p.purposes,
    p.profile_complete, p.onboarding_step, p.email_verified, p.password_reset_required,
    p.subscription_tier, p.current_period_end, p.is_founding_member, p.founding_member_expires_at
  FROM public.profiles p
  WHERE p.id = auth.uid();
$$;
REVOKE ALL ON FUNCTION public.get_my_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_profile() TO authenticated;

COMMENT ON FUNCTION public.get_my_profile() IS
  'A3 self-read contract. SECURITY DEFINER, search_path pinned. Explicit column allowlist (NOT SETOF profiles, no SELECT *). Returns ONLY the caller''s own row (WHERE p.id = auth.uid()); no argument → cannot target another user. Column types verified against production (PG 17.6): expertise is text; interests/intro_preferences/purposes are text[].';

-- ── 4) intro_requests SELECT policy: participant-only (remove the profiles subquery). ─────────────────
-- The previous "or admins" branch ran `EXISTS (SELECT 1 FROM profiles WHERE id=auth.uid() AND is_admin)`
-- as the authenticated role → would throw permission-denied once base SELECT is revoked (058), and it is
-- unnecessary: every admin intro read runs SERVER-SIDE via service_role after requireAdmin()/getUser()
-- (admin pages/routes use createAdminClient, which bypasses RLS). Member behavior — a user reads intro
-- requests they are the requester or target of — is preserved exactly.
DROP POLICY IF EXISTS "Users can read intro requests where they are involved or admins" ON public.intro_requests;
DROP POLICY IF EXISTS "Users can read intro requests where they are involved" ON public.intro_requests;
CREATE POLICY "Users can read intro requests where they are involved"
  ON public.intro_requests
  FOR SELECT
  TO authenticated
  USING (requester_id = auth.uid() OR target_user_id = auth.uid());
