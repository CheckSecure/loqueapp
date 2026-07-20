-- Lightweight Company Context pages.
--
-- `slug` is the normalized company key from lib/company/slug.ts (lowercase,
-- legal-suffix-stripped): "Google LLC" / "Google, Inc." / "Google" → "google".
-- Every metadata field is OPTIONAL and admin-curated later — the company page
-- renders name + the viewer's visible members even with NO row here, so the app
-- is fully functional before this migration is applied (deploy-safe fallback in
-- app/company/[slug]/page.tsx).
--
-- Future-ready: company news / hiring / mutual colleagues can attach via
-- companies.id in separate tables without changing this one.
--
-- Idempotent: CREATE ... IF NOT EXISTS + guarded policy.

CREATE TABLE IF NOT EXISTS companies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text UNIQUE NOT NULL,
  name         text NOT NULL,
  industry     text,
  headquarters text,
  website      text,
  company_size text,
  description  text,
  logo_url     text,
  -- Self-population / admin-override support:
  --   admin_edited=true → a human curated this row; automatic enrichment must
  --     never overwrite it.
  --   enriched_at / enrichment_source → provenance of the last automatic pass.
  admin_edited          boolean NOT NULL DEFAULT false,
  -- Enrichment provenance + retry/dedup state:
  --   enrichment_status: null (never tried) | in_progress (claimed) | enriched
  --     | not_found | failed
  --   enrichment_attempted_at: last attempt (drives the retry interval)
  --   enrichment_error: last error (for observability / retry eligibility)
  enrichment_status     text,
  enrichment_attempted_at timestamptz,
  enrichment_error      text,
  enriched_at           timestamptz,
  enrichment_source     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Idempotent add-columns so this migration also upgrades a table created from
-- an earlier version of this file.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS admin_edited boolean NOT NULL DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS enrichment_status text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS enrichment_attempted_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS enrichment_error text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS enriched_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS enrichment_source text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS company_size text;

CREATE INDEX IF NOT EXISTS companies_slug_idx ON companies (slug);

-- Company metadata is non-sensitive; readable by any authenticated member.
-- Writes are intentionally not granted to end users (curated via admin/SQL).
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'companies' AND policyname = 'companies_read_authenticated'
  ) THEN
    CREATE POLICY companies_read_authenticated
      ON companies FOR SELECT TO authenticated USING (true);
  END IF;
END $$;
