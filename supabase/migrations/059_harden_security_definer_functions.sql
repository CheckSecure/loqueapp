-- 059 — Harden the legacy SECURITY DEFINER functions (post-A3 follow-up).
--
-- Rewrites the THREE live functions (delete_user_account, is_admin, sync_email_verification) from their
-- PRODUCTION-CAPTURED definitions with identical behavior, adding: SET search_path = '' (all references
-- fully schema-qualified), a fail-closed auth.uid() guard on the self-service RPC, and identifier-free
-- warnings. It DROPs the orphaned handle_new_user() (no trigger binding, no callers — see below). Then it
-- establishes the privilege matrix EXPLICITLY (REVOKE ALL from PUBLIC/anon/authenticated, then GRANT only
-- what each function legitimately needs) — not relying on any existing ACL. CREATE OR REPLACE preserves
-- each function's oid, so the sole surviving trigger binding (on_auth_user_email_verified ->
-- sync_email_verification) stays intact and signatures are unchanged. Additive; makes NO data changes on
-- application. Does NOT touch migration 048.

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- (1) delete_user_account() — authenticated self-service (components/AccountDeletion.tsx). Exact
--     deletion sequence a–k preserved & order-preserved; auth.uid() captured once and used as the ONLY
--     scope; fail-closed on a null session; no identifiers/errors logged.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_user_account()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- a. messages authored by the caller
  DELETE FROM public.messages WHERE sender_id = v_uid;

  -- b. conversations linked to matches involving the caller (exact production structure)
  DELETE FROM public.conversations
   WHERE id IN (
     SELECT c.id
     FROM public.conversations c
     JOIN public.matches m ON c.match_id = m.id
     WHERE m.user_a_id = v_uid OR m.user_b_id = v_uid
   );

  -- c. matches involving the caller
  DELETE FROM public.matches WHERE user_a_id = v_uid OR user_b_id = v_uid;

  -- d. intro requests involving the caller
  DELETE FROM public.intro_requests WHERE requester_id = v_uid OR target_user_id = v_uid;

  -- e. meeting credits for the caller
  DELETE FROM public.meeting_credits WHERE user_id = v_uid;

  -- f. credit transactions for the caller
  DELETE FROM public.credit_transactions WHERE user_id = v_uid;

  -- g. meetings involving the caller
  DELETE FROM public.meetings WHERE requester_id = v_uid OR recipient_id = v_uid;

  -- h. notifications for the caller
  DELETE FROM public.notifications WHERE user_id = v_uid;

  -- i. the caller's profile
  DELETE FROM public.profiles WHERE id = v_uid;

  -- j. waitlist row(s) matching the caller's auth email
  DELETE FROM public.waitlist
   WHERE email = (SELECT u.email FROM auth.users u WHERE u.id = v_uid);

  -- k. the auth user itself
  DELETE FROM auth.users WHERE id = v_uid;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- (2) handle_new_user() — ORPHANED legacy SECURITY DEFINER function. Production trigger preflight
--     confirmed auth.users has exactly ONE non-internal trigger (on_auth_user_email_verified ->
--     public.sync_email_verification); handle_new_user has NO trigger binding and ZERO repository
--     callers. Signup/profile/credit creation runs through app-controlled server paths
--     (provisionMemberRecords + the credit grant in app/actions.ts), so this is a dead, directly-
--     callable, privileged credit/profile-creation surface — DROP it (never recreate/grant). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.handle_new_user();

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- (3) is_admin() — self-only boolean. Null session → false. No argument (cannot target another user).
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_admin()
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN false
    ELSE COALESCE((SELECT p.is_admin FROM public.profiles p WHERE p.id = auth.uid()), false)
  END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- (4) sync_email_verification() — TRIGGER on auth.users email confirmation. Fail-OPEN (a sync error must
--     never block confirmation). Warning is now constant + identifier-free (no NEW.id, no SQLERRM).
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sync_email_verification()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  IF NEW.email_confirmed_at IS NOT NULL
     AND (
       OLD.email_confirmed_at IS NULL
       OR OLD.email_confirmed_at != NEW.email_confirmed_at
     )
  THEN
    UPDATE public.profiles
       SET email_verified = true,
           email_verified_at = NEW.email_confirmed_at
     WHERE id = NEW.id;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Fail open: never block the email confirmation. No identifiers / raw error text in the log.
  RAISE WARNING '[sync_email_verification] sync failed';
  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- FINAL PRIVILEGE MATRIX — set explicitly (do NOT rely on existing ACLs). Owner (postgres) privileges
-- are inherent and unaffected. Revoking EXECUTE does NOT stop triggers from firing.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────

-- delete_user_account(): authenticated self-service RPC + service_role.
REVOKE ALL ON FUNCTION public.delete_user_account() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_user_account() TO authenticated, service_role;


-- is_admin(): zero legitimate callers remain → service_role only (revoke authenticated too).
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO service_role;

-- sync_email_verification(): trigger-only → service_role only.
REVOKE ALL ON FUNCTION public.sync_email_verification() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_email_verification() TO service_role;
