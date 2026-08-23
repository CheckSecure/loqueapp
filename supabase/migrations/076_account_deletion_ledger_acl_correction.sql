-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 076 — ACL CORRECTION FOR public.tg_account_deletion_events_append_only()
--
-- WHAT THIS RECORDS. Migration 075 was applied to production successfully. Its post-apply audit was
-- green except for one function: tg_account_deletion_events_append_only() was executable by PUBLIC,
-- anon, authenticated and service_role. The targeted correction below was then applied manually and
-- verified in production (anon cannot execute, authenticated cannot execute, service_role can).
-- This migration is the repository's record of that manual change, so a rebuild from migrations
-- reaches the same end state. It reproduces the manual statements and nothing else.
--
-- ─── ROOT CAUSE, STATED PRECISELY ─────────────────────────────────────────────────────────────
-- Two separate defaults stack here, and only one of them is Supabase's:
--   1. PostgreSQL ITSELF grants EXECUTE on every newly created function to PUBLIC. This is core
--      behaviour, not a Supabase setting, and it applies to every CREATE FUNCTION ever written.
--   2. Supabase projects additionally carry ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS,
--      which hands anon/authenticated/service_role their own explicit entries on top.
-- So a new function arrives executable by everyone. A GRANT is additive and removes nothing; only
-- REVOKE removes. Migration 075 knew this and revoked on six of its seven functions — the
-- append-only TRIGGER function was the one omission, because it is invoked by the trigger machinery
-- rather than called by name, and it was reviewed as trigger plumbing rather than as a grantable
-- SECURITY DEFINER surface. It is both.
--
-- ─── SEVERITY, NOT OVERSTATED ─────────────────────────────────────────────────────────────────
-- The practical exploitability was low: the function is a trigger function whose entire body raises
-- an exception, and calling it outside a trigger context errors immediately. It leaks nothing and
-- mutates nothing. But it is a SECURITY DEFINER function that ran as the table owner and was
-- callable by anon, and "harmless because the body happens to be a RAISE" is a property of today's
-- body, not a guarantee. The correct posture for a SECURITY DEFINER function is that browser roles
-- cannot reach it at all.
--
-- ─── SCOPE ────────────────────────────────────────────────────────────────────────────────────
-- Function privileges ONLY. This migration does not replace or alter the function body, does not
-- touch public.account_deletion_events or any other table, creates and drops nothing, and performs
-- no INSERT, UPDATE, DELETE, TRUNCATE or backfill of any kind.
--
-- ─── IDEMPOTENCY ──────────────────────────────────────────────────────────────────────────────
-- REVOKE and GRANT are declarative: applying them when the end state already holds is a successful
-- no-op. Production is already in that state, so re-running this changes nothing there. It matters
-- for a database rebuilt from migrations, where 075 leaves the defect in place and 076 removes it.
--
-- MIGRATION 075 IS NOT MODIFIED. It is an applied production artifact and remains byte-for-byte
-- identical to sha256 62ec9710f7aa0fa094fc2551deb9da42ef09eca166e214c9d1aea4a08226920f.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Fail loudly rather than silently no-op if the function is absent: a missing function would mean
-- 075 did not apply, and quietly "succeeding" would hide that.
DO $$
BEGIN
  IF to_regprocedure('public.tg_account_deletion_events_append_only()') IS NULL THEN
    RAISE EXCEPTION
      'public.tg_account_deletion_events_append_only() does not exist — apply migration 075 first';
  END IF;
END;
$$;

-- REVOKE first, and name each grantee separately, exactly as the manual production correction did.
-- PUBLIC must be revoked explicitly: revoking from anon and authenticated leaves the PUBLIC grant
-- standing, and every role inherits it.
REVOKE ALL
  ON FUNCTION public.tg_account_deletion_events_append_only()
  FROM PUBLIC;

REVOKE ALL
  ON FUNCTION public.tg_account_deletion_events_append_only()
  FROM anon;

REVOKE ALL
  ON FUNCTION public.tg_account_deletion_events_append_only()
  FROM authenticated;

-- service_role keeps EXECUTE. Note what this does and does not matter for: the trigger itself
-- invokes this function through the trigger machinery, which does not consult EXECUTE privileges at
-- all, so append-only enforcement would hold even with no grants whatsoever. The grant is here
-- because it is what was applied and verified in production, and removing it would make the
-- repository disagree with the live database.
GRANT EXECUTE
  ON FUNCTION public.tg_account_deletion_events_append_only()
  TO service_role;

COMMIT;
