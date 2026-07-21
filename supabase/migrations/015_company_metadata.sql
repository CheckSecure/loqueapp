-- Company metadata FALLBACK layer.
--
-- Admin-editable curated metadata used ONLY when homepage scraping can't provide
-- a value (e.g. a company whose site returns 403). It is deliberately SEPARATE
-- from the `companies` table:
--   * `companies` holds live, enrichment-owned data (scraped) plus admin
--     OVERRIDES (admin_edited = true, top precedence, never re-scraped).
--   * `company_metadata` holds low-precedence FALLBACKS: used only when neither an
--     existing value nor a fresh scrape produced one. This replaces the former
--     hardcoded, in-code fallback descriptions — now data, editable by admins.
--
-- Precedence in the enrichment pipeline (lib/company/enrichment/run.ts):
--   admin override (companies.admin_edited) > existing companies value
--     > scraped homepage metadata > company_metadata fallback > null
--
-- Access is service-role only (enrichment + admin endpoints use the admin
-- client, which bypasses RLS). No public policies — the company page reads
-- `companies`, never this table directly.

CREATE TABLE IF NOT EXISTS company_metadata (
  slug          text PRIMARY KEY,
  description   text,
  industry      text,
  headquarters  text,
  logo_url      text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text
);

ALTER TABLE company_metadata ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (admin client) may read/write.
