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
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

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
