-- ==============================================================================================
-- 071 - LEAST PRIVILEGE FOR service_role ON public.introduction_email_outbox
--
-- ALREADY APPLIED IN PRODUCTION, BY HAND. This migration exists so the repository states the
-- privilege contract that production actually holds, rather than leaving it as an undocumented
-- manual fix. Re-running it is a no-op on a database that already matches.
--
-- --- WHAT WENT WRONG IN 070 -------------------------------------------------------------------
-- Migration 070 wrote what looked like a complete privilege statement:
--
--     REVOKE ALL ON TABLE public.introduction_email_outbox FROM PUBLIC;
--     REVOKE ALL ON TABLE public.introduction_email_outbox FROM anon, authenticated;
--     GRANT SELECT, INSERT, UPDATE ON TABLE public.introduction_email_outbox TO service_role;
--
-- and it was wrong in one specific way: A GRANT IS ADDITIVE. Naming only SELECT, INSERT and UPDATE
-- does not take anything away, so it cannot remove a DELETE privilege that already exists. In a
-- Supabase project, ALTER DEFAULT PRIVILEGES gives service_role broad table access at CREATE TABLE
-- time, so the outbox was born with DELETE and the narrow GRANT silently left it in place.
--
-- The correct form is REVOKE-then-GRANT: strip everything, then grant back exactly the three verbs
-- the worker needs. That is what production now has, and what this migration records.
--
-- --- WHY DELETE MATTERS HERE ------------------------------------------------------------------
-- The outbox is the durable record that an email is owed. A worker that could DELETE an event could
-- erase that obligation - which is precisely the failure mode the transactional outbox was built to
-- eliminate. The worker never deletes: it settles rows to 'sent', 'skipped' or back to 'pending',
-- so history stays auditable. Removing DELETE turns "the worker does not delete" from a property of
-- the code into a property of the database.
--
-- --- WHY THIS WAS NOT CAUGHT BY THE LOCAL HARNESS ---------------------------------------------
-- The PostgreSQL harness runs on a plain local cluster, which has no Supabase default privileges,
-- so the outbox was created there with no DELETE grant to inherit and the post-apply check passed.
-- The gap was a difference between the test environment and production, not a missing assertion.
-- The audit and the structural tests now assert all four verbs explicitly.
--
-- Migrations 063-070 are untouched. Nothing here grants anything to PUBLIC, anon or authenticated,
-- and nothing here restores service_role EXECUTE on public.consume_credits_and_create_match.
-- ==============================================================================================

BEGIN;

-- Strip everything first. This is the whole point: a narrow GRANT cannot remove a wide one.
REVOKE ALL
ON TABLE public.introduction_email_outbox
FROM service_role;

GRANT SELECT, INSERT, UPDATE
ON TABLE public.introduction_email_outbox
TO service_role;

-- Fail loudly rather than leave a mismatch behind. If a future default-privilege change re-adds
-- DELETE, this migration stops instead of silently "succeeding".
DO $$
BEGIN
  IF NOT has_table_privilege(
    'service_role',
    'public.introduction_email_outbox',
    'SELECT'
  )
  OR NOT has_table_privilege(
    'service_role',
    'public.introduction_email_outbox',
    'INSERT'
  )
  OR NOT has_table_privilege(
    'service_role',
    'public.introduction_email_outbox',
    'UPDATE'
  )
  OR has_table_privilege(
    'service_role',
    'public.introduction_email_outbox',
    'DELETE'
  )
  THEN
    RAISE EXCEPTION 'Outbox service_role privileges do not match the required contract';
  END IF;
END
$$;

COMMIT;
