-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 094 — RESUME-ACCESS RESENDS NOW CARRY THEIR OWN FALLBACK, AND RETIRE THE ONE THEY REPLACE
--
-- ─── WHAT THIS AMENDS ─────────────────────────────────────────────────────────────────────────
-- Migration 078 states: "ISSUING A NEW RESUME TOKEN NEVER RETIRES AN OLDER ONE. Reminders and
-- access-resends add tokens; they do not rotate." That is now HALF true, and this file is the
-- record of which half changed. 078 is applied and is left byte-for-byte alone.
--
--   REMINDERS and FIRST INVITES: unchanged. They still add a token and retire nothing.
--   RESUME-ACCESS RESENDS:       now retire every older live token for the invitation, on the
--                                same prepare -> send -> finalize ordering 078 already defines.
--
-- ─── WHY THE RESUME-ACCESS EMAIL CHANGED ──────────────────────────────────────────────────────
-- sendResumeAccessEmail passed `resumeLink: null`. That email is, by definition, the one a person
-- receives BECAUSE their previous sign-in link died — and it was the one email that shipped without
-- a durable way back in. When its own authentication link lapsed (the project's Email OTP expiry,
-- ~1 hour), the recipient was returned to exactly the dead end 078 exists to abolish, one layer
-- further down, and their only remaining route was to find the ORIGINAL email again.
--
-- The server cannot simply re-send the same resume link: only the SHA-256 is persisted, so the
-- plaintext is unrecoverable by construction (078, and deliberately so). A fresh token must be
-- minted. Minting one per request with no retirement would let a single token spawn unbounded live
-- capabilities for one invitation, which is why retirement comes with it.
--
-- ─── WHY NOT REUSE finalize_resume_rotation ───────────────────────────────────────────────────
-- That finalizer is bound to an invitation_rotation_operations row, and begin_resume_rotation
-- CONVERGES on any active operation for the invitation. Routing member-triggered resume requests
-- through it would couple them to admin rotations: a member's request could converge onto an
-- admin's in-flight operation whose replacement plaintext this process never held (and so could not
-- email), and a member's abandoned 'prepared' row would block a genuine admin rotation with a 409.
-- The two paths stay independent. This function does the one thing the resume path needs.
--
-- ─── ORDERING IS THE SAME, AND IT IS THE WHOLE SAFETY ARGUMENT ────────────────────────────────
-- PREPARE (mint the replacement; every existing link still live) -> SEND -> FINALIZE (retire the
-- others), and finalize ONLY on a definite provider acceptance. An uncertain or failed send retires
-- NOTHING, leaving more working links than intended rather than fewer. This function is the
-- FINALIZE step only; it never sends and never mints.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Retire every live resume token for one invitation EXCEPT the keeper.
--
-- FAIL-SAFE, NOT FAIL-FAST. If the keeper is not itself a live token for this invitation (revoked,
-- superseded, or belonging to another invitation), this retires NOTHING and returns 0 rather than
-- raising. It is called AFTER the provider has accepted the email, so an exception here could not
-- un-send anything; the only recoverable direction at that point is to leave existing links alone.
-- finalize_resume_rotation raises in the same situation because it runs inside an admin request that
-- can still be reported and retried — a difference in caller, not in intent.
--
-- IDEMPOTENT: a second call retires nothing further and returns 0.
CREATE OR REPLACE FUNCTION public.supersede_other_resume_tokens(
  p_waitlist_id   uuid,
  p_keep_token_id uuid
) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_n integer;
BEGIN
  IF p_waitlist_id IS NULL OR p_keep_token_id IS NULL THEN
    RETURN 0;
  END IF;

  -- The keeper must be live and belong to this invitation, or we touch nothing.
  IF NOT EXISTS (
    SELECT 1 FROM public.invitation_resume_tokens
     WHERE id = p_keep_token_id
       AND waitlist_id = p_waitlist_id
       AND revoked_at IS NULL
       AND superseded_at IS NULL
  ) THEN
    RETURN 0;
  END IF;

  UPDATE public.invitation_resume_tokens
     SET superseded_at = pg_catalog.now()
   WHERE waitlist_id = p_waitlist_id
     AND id <> p_keep_token_id
     AND revoked_at IS NULL
     AND superseded_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  RETURN v_n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.supersede_other_resume_tokens(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.supersede_other_resume_tokens(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.supersede_other_resume_tokens(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.supersede_other_resume_tokens(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.supersede_other_resume_tokens(uuid, uuid) IS
  'Retires every live resume token for an invitation except the keeper, so one invitation never '
  'accumulates live tokens. Called ONLY after a resume-access email is definitely accepted by the '
  'provider — never before a send, never on an uncertain outcome, and never on a reminder or a '
  'first invite (those still add without retiring). Fail-safe: an ineligible keeper retires nothing '
  'and returns 0. Idempotent. See migration 094; amends the no-rotation note in migration 078.';

COMMIT;
