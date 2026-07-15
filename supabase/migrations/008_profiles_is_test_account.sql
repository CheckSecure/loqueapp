-- Durable internal-QA marker.
--
-- Profiles with is_test_account = true are permanent internal test accounts.
-- Application code excludes them from every member-facing candidate/recipient
-- pool (recommendations, introduction batches, batch replacements, opportunities,
-- digests, automated outreach) and from member-count metrics — using the
-- condition `is_test_account IS NOT TRUE` — so QA accounts can live permanently
-- in production without ever reaching real members or distorting counts.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. NOT NULL DEFAULT false means every
-- existing (real) profile is is_test_account=false and therefore unaffected.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_test_account boolean NOT NULL DEFAULT false;
