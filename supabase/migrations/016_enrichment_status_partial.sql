-- Allow the `partial` enrichment status.
--
-- The companies table has a CHECK constraint (companies_enrichment_status_check)
-- that predates the `partial` status ("canonical identity resolved, homepage
-- metadata unavailable"). Writing `partial` was rejected, so registry companies
-- whose homepage is blocked (403/timeout) failed to persist and got stuck in
-- `in_progress`. This widens the constraint to include `partial`.
--
-- The application code is ALSO defensive: if this migration is not yet applied,
-- runEnrichment degrades a `partial` write to `enriched` (a permitted value) so
-- rows still receive their identity + data — see lib/company/enrichment/run.ts.
-- Applying this migration lets `partial` be stored accurately.

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_enrichment_status_check;

ALTER TABLE companies ADD CONSTRAINT companies_enrichment_status_check
  CHECK (enrichment_status IS NULL OR enrichment_status IN
    ('enriched', 'partial', 'not_found', 'failed', 'in_progress'));
