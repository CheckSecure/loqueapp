-- 031_company_aliases.sql
-- Phase 1 — company_aliases: the runtime authority mapping a normalized company
-- string to exactly ONE canonical company.
--
-- lib/company/registry.ts remains COMPILED SEED DATA; this table is the runtime
-- source of truth so admins can add/correct aliases without a deploy. A seed step
-- (scripts/backfill-company-ids.ts) populates it from the registry + backfill.
--
-- CORE GUARANTEE: UNIQUE (alias_normalized) — a normalized key resolves to one
-- company. Merges REPOINT alias rows (company_id) rather than add a second
-- mapping, so duplicates can never silently re-form.
--
-- No read path depends on this yet (shadow). Service-role writes only; reads
-- granted to authenticated members (same posture as `companies`).
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS + guarded constraints/policy.

CREATE TABLE IF NOT EXISTS company_aliases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  alias_text       text NOT NULL,
  alias_normalized text NOT NULL,
  source           text NOT NULL DEFAULT 'admin',
  confidence       text,
  is_ambiguous     boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  CONSTRAINT company_aliases_normalized_unique UNIQUE (alias_normalized)
);

CREATE INDEX IF NOT EXISTS company_aliases_company_idx
  ON company_aliases (company_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_aliases_source_check') THEN
    ALTER TABLE company_aliases ADD CONSTRAINT company_aliases_source_check
      CHECK (source IN ('registry', 'backfill', 'admin', 'onboarding'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_aliases_confidence_check') THEN
    ALTER TABLE company_aliases ADD CONSTRAINT company_aliases_confidence_check
      CHECK (confidence IS NULL OR confidence IN ('exact', 'canonical', 'fuzzy', 'manual'));
  END IF;
END $$;

ALTER TABLE company_aliases ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'company_aliases' AND policyname = 'company_aliases_read_authenticated'
  ) THEN
    CREATE POLICY company_aliases_read_authenticated
      ON company_aliases FOR SELECT TO authenticated USING (true);
  END IF;
END $$;
