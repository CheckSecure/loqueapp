-- 048 — Presence privacy — CLEANUP half (contract). Drop the legacy column.
--
-- The EXPANSION migration 046 created member_presence + the coarse-label RPC and backfilled
-- every value, while LEAVING profiles.last_active_at intact so the old code kept working.
-- Once the new application version (which reads/writes member_presence only and never
-- selects profiles.last_active_at) is deployed and verified, this migration removes the
-- socially-leaky legacy column — finalizing the data-boundary privacy fix.
--
-- DEPLOY ORDER: run ONLY after 046 is applied AND the new code is live + smoke-tested.
-- Idempotent: guarded on column existence so a re-run is a clean no-op. The backfill in 046
-- already copied every value into member_presence, so this drop loses no data.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'last_active_at'
  ) THEN
    ALTER TABLE public.profiles DROP COLUMN last_active_at;
  END IF;
END $$;
