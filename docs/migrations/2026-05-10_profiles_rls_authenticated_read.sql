-- 2026-05-10: Fix profiles SELECT RLS — close anonymous member directory exposure
--
-- PROBLEM:
--   Three SELECT policies existed on public.profiles, applied directly in the
--   Supabase dashboard (no git history for any of them):
--
--   1. "profiles_select_all"
--      USING (true) — grants SELECT to every role including anon.
--      Origin: Replit agent circa March 2026, initial Supabase setup.
--      Effect: all 37 member rows readable without authentication via the
--      NEXT_PUBLIC_SUPABASE_ANON_KEY (shipped in every client bundle). Fields
--      exposed: email, stripe_customer_id, stripe_subscription_id,
--      subscription_tier, subscription_status, account_status, is_admin,
--      is_founding_member, founding_member_expires_at, admin_priority,
--      trust_score, networkValueScore, deactivated_at, deactivation_reason,
--      and all profile content (bio, expertise, location, etc.).
--
--   2. "Users can view own profile or admin views all"
--      USING ((auth.uid() = id) OR is_admin())
--      Narrower than profiles_authenticated_read for regular members (own row
--      only). Superseded by profiles_authenticated_read, which allows any
--      authenticated member to read any profile — required for intro cards,
--      match views, conversation partner display, and opportunity flows.
--      The is_admin() arm is also irrelevant: admin always uses
--      createAdminClient() (service role, bypasses RLS).
--
--   3. "profiles_authenticated_read"  ← the one we added in this fix
--      USING (auth.uid() IS NOT NULL)
--      Correct scope for V1. Added 2026-05-10.
--
--   Because Postgres OR-combines policies for the same command, profiles_select_all
--   (true) dominated all three, making profiles_authenticated_read a no-op.
--
-- is_admin() FUNCTION:
--   Exists in public schema. Returns boolean by reading profiles.is_admin for
--   auth.uid(). Returns null for unauthenticated context (no row match).
--   Not referenced in any tracked codebase file — applied in dashboard only.
--   Codebase grep confirms zero references to is_admin() in app/, lib/,
--   components/, migrations/ — only is_admin (the column) appears.
--   Verify no other table's policy references is_admin() before dropping:
--
--     SELECT schemaname, tablename, polname, polcmd,
--            pg_get_expr(polqual, polrelid) AS using_expr
--     FROM pg_policy p
--     JOIN pg_class c ON c.oid = p.polrelid
--     JOIN pg_namespace n ON n.oid = c.relnamespace
--     WHERE pg_get_expr(polqual, polrelid) LIKE '%is_admin%'
--       AND n.nspname = 'public';
--
--   Run this in the Supabase SQL editor BEFORE applying the drops below.
--   If it returns rows for tables other than profiles, stop and investigate.
--
-- APPLY (in order):
--   1. Run is_admin() cross-table query above. Confirm only profiles rows.
--   2. Run DROP statements below in Supabase Dashboard → SQL Editor.
--   3. Run verification SELECT to confirm only profiles_authenticated_read remains.
--   4. Re-run anon-key test: profiles should return 0 rows.
--   5. Sign in as a non-admin member, confirm dashboard/intros/network loads.
--   6. Sign in as bizdev91@gmail.com, confirm admin pages load.
--
-- ROLLBACK:
--   CREATE POLICY "profiles_select_all" ON public.profiles FOR SELECT USING (true);
--   (Restores the broken state — only use if post-apply verification fails
--    and the cause is the policy change, not something unrelated.)

-- ── Step 1: Drop the permissive anon policy (root cause) ─────────────────────
DROP POLICY "profiles_select_all" ON public.profiles;

-- ── Step 2: Drop the self-scoped policy (superseded) ─────────────────────────
DROP POLICY "Users can view own profile or admin views all" ON public.profiles;

-- ── Step 3: Verify — only profiles_authenticated_read should remain for SELECT ─
SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr
FROM pg_policy
WHERE polrelid = 'public.profiles'::regclass
ORDER BY polcmd, polname;

-- ── Step 4: profiles_authenticated_read policy ────────────────────────────────
-- This policy was applied separately in commit 2235ce8 (2026-05-10) before the
-- DROP statements above. Documented here for completeness — do not re-execute.
--
--   CREATE POLICY "profiles_authenticated_read"
--     ON public.profiles
--     FOR SELECT
--     USING (auth.uid() IS NOT NULL);

-- ── Step 5: Enable RLS on profiles ───────────────────────────────────────────
-- Applied 2026-05-10 in Supabase dashboard SQL editor.
-- Without this, all policies are inert (Postgres does not enforce RLS unless
-- explicitly enabled per-table).
--
--   ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- POST-FIX STATE:
-- RLS enabled. Only profiles_authenticated_read remains as a SELECT policy.
-- Anon-key test confirmed: content-range */0, row fetch [].
-- Any authenticated user can SELECT any profile row. This matches existing app
-- behavior via createAdminClient() in server routes and is a strict improvement
-- over the pre-fix anonymous exposure.
-- A relationship-scoped policy (self + connections + suggested + conversation
-- participants) is the C8 Step 2 follow-up and is out of scope for this fix.
