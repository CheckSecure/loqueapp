-- ==============================================================================================
-- 068 - REVOKE service_role EXECUTE ON THE RAW DELEGATE
--
-- DO NOT APPLY THIS UNTIL THE APPLICATION SHA THAT CALLS public.finalize_mutual_match_atomic IS
-- DEPLOYED AND READY. It is the LAST step of the rollout, not part of the 067 deploy.
--
-- --- WHY IT IS A SEPARATE MIGRATION -----------------------------------------------------------
-- The application deployed at commit 0823612 calls public.consume_credits_and_create_match
-- DIRECTLY with the service-role key, from lib/introductions/finalizeMutualMatch.ts and
-- app/actions.ts. If 067 had revoked service_role, every mutual finalization would have failed
-- from the instant 067 was applied until the new build went live. Splitting the revoke out is the
-- only way to get a zero-downtime rollout; it is not cosmetic sequencing.
--
-- --- WHY THE WRAPPER STILL WORKS AFTERWARDS ---------------------------------------------------
-- public.finalize_mutual_match_atomic is SECURITY DEFINER owned by postgres, so its body executes
-- as postgres - which also owns the delegate. A function owner retains EXECUTE on its own function
-- regardless of what is granted to anyone else, so removing service_role EXECUTE severs the direct
-- path without severing the wrapper path. After this migration the ONLY way to reach the delegate
-- is through the wrapper, which revalidates consent under the member advisory locks.
--
-- --- CONTAINMENT IS NOT WEAKENED ---------------------------------------------------------------
-- PUBLIC, anon and authenticated were already revoked in 067 and are revoked again here. This
-- migration only ever REMOVES privilege, so there is no window in which any browser role can
-- execute anything.
--
-- --- ROLLBACK ----------------------------------------------------------------------------------
-- If the new SHA has to be rolled back to 0823612 or earlier, re-run exactly:
--   GRANT EXECUTE ON FUNCTION public.consume_credits_and_create_match(uuid, uuid, boolean)
--     TO service_role;
-- That restores the direct path for the old code WITHOUT restoring any browser-role access.
-- ==============================================================================================

BEGIN;

REVOKE ALL ON FUNCTION public.consume_credits_and_create_match(uuid, uuid, boolean)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_credits_and_create_match(uuid, uuid, boolean)
  FROM anon, authenticated;

-- The direct application path is now closed. Only the SECURITY DEFINER wrapper can reach it.
REVOKE ALL ON FUNCTION public.consume_credits_and_create_match(uuid, uuid, boolean)
  FROM service_role;

-- Restated, not assumed: the wrapper remains the one supported entry point.
GRANT EXECUTE ON FUNCTION public.finalize_mutual_match_atomic(uuid, uuid, boolean)
  TO service_role;

COMMIT;
