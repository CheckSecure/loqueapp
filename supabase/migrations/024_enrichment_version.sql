-- 024_enrichment_version.sql
-- Persistent enrichment version stamp — makes the enrichment pipeline fully
-- incremental and idempotent across future changes.
--
-- companies.enrichment_version records the ENRICHMENT_VERSION (see
-- lib/company/enrichment/version.ts) under which a row was last successfully
-- enriched. A row whose stamp is NULL or < the current code constant is
-- classified `outdated_version` and becomes eligible for a forced re-enrich on
-- the next incremental run — with no manual list. Bumping the code constant is
-- all it takes to re-flow improved enrichment through the affected pages;
-- everything already at the current version is skipped.
--
-- The application code degrades gracefully if this migration has not been applied
-- (it persists without the stamp and treats versioning as inert), so code and
-- migration can deploy in either order.
--
-- Backfill: existing `enriched` rows already meet the current (v1) standard, so
-- stamp them 1 — future runs skip them. not_found / failed / partial / NULL rows
-- are intentionally left unstamped so they remain retry-eligible and self-heal
-- once website discovery improves (e.g. SEARCH_API_KEY is configured).

ALTER TABLE companies ADD COLUMN IF NOT EXISTS enrichment_version integer;

UPDATE companies
   SET enrichment_version = 1
 WHERE enrichment_status = 'enriched'
   AND enrichment_version IS NULL;

CREATE INDEX IF NOT EXISTS idx_companies_enrichment_version
    ON companies (enrichment_version);
