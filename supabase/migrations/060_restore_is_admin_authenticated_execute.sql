-- 060 — Restore authenticated EXECUTE on public.is_admin() (migration-059 incident correction).
--
-- ROOT CAUSE: migration 059 revoked authenticated EXECUTE on public.is_admin() on an INCORRECT
-- "zero callers" conclusion (that grep only covered the application/repo code, not the DATABASE). In
-- production, RLS policies on core member tables call public.is_admin() inside their USING/CHECK
-- expression. Those policies are evaluated AS THE authenticated role; once that role lost EXECUTE, every
-- such policy raised
--   ERROR: permission denied for function is_admin
-- which failed the entire query — so member reads returned an error, not rows. Network rendered "No
-- connections yet" and credits rendered 0 because the app silently treated the failed query as an empty
-- successful result (fixed separately in the app in this same change).
--
-- LIVE PRODUCTION AUDIT (read-only) — public.is_admin() is invoked by 17 policies across SIX tables:
--   conversations (1), intro_requests (3), matches (4), meeting_credits (4), profiles (3), waitlist (2).
-- These policies are OUT-OF-BAND (authored directly in prod, not in any repo migration), which is exactly
-- why a repository-only grep concluded "zero callers." matches -> Network; meeting_credits -> credits are
-- the surfaces that visibly failed; the other four tables share the same helper and the same exposure.
-- A structural regression assertion documenting all six tables lives in migration-060-incident-correction
-- test so no future privilege-hardening change can repeat the repo-only "no callers" mistake.
--
-- Emergency recovery already ran `GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;` which
-- immediately restored Network + credits. This migration VERSION-CONTROLS that safe grant.
--
-- Migration 059 is IMMUTABLE (applied + committed) — this is a forward fix. The hardened is_admin() body
-- from 059 is PRESERVED UNCHANGED (SECURITY DEFINER, search_path='', no argument, auth.uid()-bound,
-- null -> false, returns only the caller's own admin boolean). Only the grant is corrected: authenticated
-- (required by the policy helper) + service_role; PUBLIC and anon remain revoked.
--
-- Additive, idempotent, NO data changes. Does NOT touch migration 048.

REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC, anon;   -- reassert (idempotent; keep locked)
GRANT  EXECUTE ON FUNCTION public.is_admin() TO authenticated;    -- THE FIX: RLS policy helper needs it
GRANT  EXECUTE ON FUNCTION public.is_admin() TO service_role;     -- preserved
