-- ==============================================================================================
-- 073 - LEAST PRIVILEGE FOR public.credit_transactions
--
-- ALREADY APPLIED IN PRODUCTION, BY HAND. This migration exists so the repository states the
-- privilege contract production actually holds, rather than leaving it as an undocumented manual
-- fix. Re-running it against a database that already matches is a no-op.
--
-- --- WHY 072 DID NOT ACHIEVE THIS ------------------------------------------------------------
-- Migration 072 wrote what looked like a complete privilege statement:
--
--     REVOKE INSERT, UPDATE, DELETE ON TABLE public.credit_transactions FROM PUBLIC;
--     REVOKE INSERT, UPDATE, DELETE ON TABLE public.credit_transactions FROM anon, authenticated;
--     GRANT SELECT, INSERT ON TABLE public.credit_transactions TO service_role;
--
-- and it was insufficient for the same reason migration 070's outbox grant was: A GRANT IS
-- ADDITIVE, AND A NARROW REVOKE ONLY REMOVES WHAT IT NAMES. Supabase's ALTER DEFAULT PRIVILEGES
-- hands roles broad table access at CREATE TABLE time, and this table was created out of band, so
-- it carried inherited grants that 072's named list never touched - including UPDATE, DELETE and
-- TRUNCATE for service_role, and privileges for anon. Naming three verbs cannot remove a fourth.
--
-- This is the second time the same class of defect has appeared (see 071 for the outbox). The
-- correct shape is always REVOKE ALL first, then grant back exactly what is needed.
--
-- --- WHY THESE PARTICULAR PRIVILEGES ---------------------------------------------------------
--   anon           nothing at all. An unauthenticated session has no business reading a ledger.
--   authenticated  SELECT only. A member may read their own credit history through RLS; they may
--                  never write it. Every mutation verb is revoked.
--   service_role   SELECT and INSERT only. The ledger is APPEND-ONLY: migration 072's trigger
--                  refuses to modify or delete an event-keyed row, and removing UPDATE, DELETE and
--                  TRUNCATE means the server cannot even attempt it. A correction is a new
--                  compensating row, never an edit of the original.
--
-- The DO block fails loudly rather than leaving a mismatch behind: if a future default-privilege
-- change re-adds any of these, this migration stops instead of silently "succeeding".
--
-- Migrations 063-072 are untouched. Nothing here grants PUBLIC/anon/authenticated any mutation, and
-- nothing restores service_role EXECUTE on the raw delegate that migration 068 removed.
-- ==============================================================================================

BEGIN;

REVOKE ALL
ON TABLE public.credit_transactions
FROM PUBLIC, anon;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
ON TABLE public.credit_transactions
FROM authenticated;

REVOKE ALL
ON TABLE public.credit_transactions
FROM service_role;

GRANT SELECT, INSERT
ON TABLE public.credit_transactions
TO service_role;

DO $$
BEGIN
  IF has_table_privilege(
       'anon',
       'public.credit_transactions',
       'SELECT'
     )
     OR has_table_privilege(
       'anon',
       'public.credit_transactions',
       'INSERT'
     )
     OR has_table_privilege(
       'anon',
       'public.credit_transactions',
       'UPDATE'
     )
     OR has_table_privilege(
       'anon',
       'public.credit_transactions',
       'DELETE'
     )
     OR has_table_privilege(
       'anon',
       'public.credit_transactions',
       'TRUNCATE'
     )
  THEN
    RAISE EXCEPTION 'anon retains an unexpected credit_transactions privilege';
  END IF;

  IF has_table_privilege(
       'authenticated',
       'public.credit_transactions',
       'INSERT'
     )
     OR has_table_privilege(
       'authenticated',
       'public.credit_transactions',
       'UPDATE'
     )
     OR has_table_privilege(
       'authenticated',
       'public.credit_transactions',
       'DELETE'
     )
     OR has_table_privilege(
       'authenticated',
       'public.credit_transactions',
       'TRUNCATE'
     )
  THEN
    RAISE EXCEPTION 'authenticated retains a credit_transactions mutation privilege';
  END IF;

  IF NOT has_table_privilege(
       'service_role',
       'public.credit_transactions',
       'SELECT'
     )
     OR NOT has_table_privilege(
       'service_role',
       'public.credit_transactions',
       'INSERT'
     )
     OR has_table_privilege(
       'service_role',
       'public.credit_transactions',
       'UPDATE'
     )
     OR has_table_privilege(
       'service_role',
       'public.credit_transactions',
       'DELETE'
     )
     OR has_table_privilege(
       'service_role',
       'public.credit_transactions',
       'TRUNCATE'
     )
  THEN
    RAISE EXCEPTION 'service_role credit_transactions privileges do not match the required contract';
  END IF;
END
$$;

COMMIT;
