-- 023_intro_requests_batch_id_drop_fk.sql
--
-- Unified Recommendation Queue — FIX. intro_requests.batch_id pre-existed with a
-- foreign key (intro_requests_batch_id_fkey) to the LEGACY batch table. In the
-- unified model, batch_id must group rows under their recommendation_batches batch,
-- so that FK silently rejects every write (all existing batch_id values are NULL —
-- the old code's writes failed the same FK). batch_id is treated as a plain grouping
-- key: the queue service guarantees a batch row exists before any intro_requests row
-- references it, so no DB-level FK is needed (and an FK to recommendation_batches
-- would fight the backfill's metadata-last write order). Drop the stale FK.
--
-- SAFE: all intro_requests.batch_id are currently NULL, so nothing references the
-- old table via this column — dropping affects zero rows.
--
-- OPERATOR PRE-CHECK (expect 0):
--   select count(*) from public.intro_requests where batch_id is not null;
-- OPTIONAL (capture what the FK pointed at, for the record):
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conname = 'intro_requests_batch_id_fkey';
--
-- NOT YET APPLIED. Operator applies in the Supabase Dashboard.

alter table public.intro_requests
  drop constraint if exists intro_requests_batch_id_fkey;
