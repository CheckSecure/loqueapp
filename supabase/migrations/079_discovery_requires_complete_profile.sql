-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 079 — DISCOVERY ELIGIBILITY BECOMES A DIRECT PREDICATE
--
-- WHY. The safety argument for creating an incomplete profile row used to be transitive: matching
-- filters on profile_complete = true, so an incomplete profile can never acquire a relationship, so
-- can_discover_profile() can never return true for one. That reasoning holds only for relationships
-- formed in the FUTURE. A member who completed onboarding, acquired matches and intro_requests, and
-- was later reverted to incomplete — or any historical row that already exists — is discoverable
-- today, because the predicate tests the RELATIONSHIP and never tests the profile.
--
-- A privacy contract must not rest on an argument about what other code will decline to do. This
-- makes completeness a direct condition of discovery.
--
-- ─── EVERY CALLER WAS CHECKED BEFORE CHANGING THIS ────────────────────────────────────────────
--   1. public.public_profiles view (057)                — the member-facing discovery contract
--   2. profiles_relationship_read RLS policy (043)      — base-table SELECT is revoked (058), so
--                                                         this is defence in depth today
--   3. public.member_presence_labels(uuid[]) (046)      — gates presence on the same predicate
-- All three want the same thing: "may the viewer see this member as a member?" All three benefit.
--
-- ─── THE SELF BRANCH IS PRESERVED EXACTLY, AND THAT IS LOAD-BEARING ───────────────────────────
-- The function begins `auth.uid() = member_id OR (...)`. Adding completeness to the OUTER
-- expression would stop a member reading their OWN row while onboarding — which is precisely the
-- state every new member is in, and would break the surfaces they need to finish. The new
-- conditions are therefore added to the RELATIONSHIP branch ONLY. A member can always see
-- themselves; other members see them only once they are a complete, non-test member.
--
-- ─── WHAT IS DELIBERATELY *NOT* ADDED, AND WHY ────────────────────────────────────────────────
-- account_status is NOT folded in, though it was tempting. Migration 057 removed account_status
-- from public_profiles on purpose and moved deactivation checks server-side; surfaces like the
-- Network list read it via service_role to render a "deactivated" badge, and message history shows
-- past counterparties. Making deactivation hide the row would silently blank names out of existing
-- conversations and break that badge — a user-visible behaviour change well beyond the defect being
-- fixed here. It is a separate, reviewable decision and is flagged rather than smuggled in.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Transcribed from migration 057 with the relationship branch narrowed. The relationship conditions
-- themselves are UNCHANGED, character for character, so this migration alters exactly one thing.
CREATE OR REPLACE FUNCTION public.can_discover_profile(member_id uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT
    auth.uid() = member_id
    OR (
      -- NEW: discovery eligibility as a DIRECT predicate on the target, not an inference about
      -- what matching would have refused to do. An incomplete or test profile is not discoverable
      -- by another member even if historical relationship rows already exist.
      EXISTS (
        SELECT 1 FROM public.profiles tgt
        WHERE tgt.id = member_id
          AND tgt.profile_complete IS TRUE
          AND tgt.is_test_account IS NOT TRUE
      )
      AND NOT EXISTS (
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

-- Grants restated exactly as 057 left them. CREATE OR REPLACE preserves privileges, so this is an
-- assertion of intent rather than a change.
REVOKE ALL ON FUNCTION public.can_discover_profile(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_discover_profile(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.can_discover_profile(uuid) TO authenticated;

COMMENT ON FUNCTION public.can_discover_profile(uuid) IS
  'A3 discovery predicate. Self is always visible. Another member is discoverable only when the '
  'TARGET is a complete, non-test profile AND an unblocked match/intro relationship exists. '
  'Completeness is a direct condition (migration 079), not an inference from what matching would '
  'have refused to create. account_status is deliberately NOT part of this predicate — see 079.';

COMMIT;
