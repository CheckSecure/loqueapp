-- 2026-05-10: Restrict profiles SELECT to authenticated users
--
-- PROBLEM:
--   profiles had no RLS SELECT restriction for the anon role.
--   All 37 member rows — including email, stripe_customer_id,
--   stripe_subscription_id, subscription_tier, account_status,
--   deactivation_reason, admin_priority, trust_score, and all
--   profile content — were readable by anyone possessing the
--   NEXT_PUBLIC_SUPABASE_ANON_KEY (shipped in every client bundle).
--
-- FIX (Step 1 of 2):
--   Require auth.uid() IS NOT NULL for SELECT. Kills anon exposure
--   immediately. Authenticated members can still read any profile row
--   (needed for intro cards, match views, conversation partner display).
--
-- STEP 2 (deferred):
--   Write relationship-scoped policy: self-read + connected + suggested
--   + conversation-participant. Non-trivial; do carefully after Step 1
--   closes the immediate exposure.
--
-- APPLY:
--   Paste into Supabase Dashboard → SQL Editor and run.
--   Verify: anon-key query against profiles returns 0 rows.
--   Verify: authenticated dashboard loads correctly.
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS "profiles_authenticated_read" ON public.profiles;

CREATE POLICY "profiles_authenticated_read"
  ON public.profiles
  FOR SELECT
  USING (auth.uid() IS NOT NULL);
