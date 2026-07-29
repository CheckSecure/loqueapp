-- 030_companies_merge.sql
-- Phase 0 — Company entity hardening for the normalization system.
--
-- Adds merge/tombstone + lifecycle columns so duplicate `companies` rows can be
-- collapsed into one canonical entity WITHOUT deleting rows (Company Page URLs
-- redirect; history is preserved). No read path depends on these yet — this is
-- pure schema surface for later phases.
--
-- DELIBERATELY MINIMAL: member_count and normalized_name are intentionally NOT
-- added here (deferred to when the admin/dedupe surfaces that consume them ship).
--
-- Lifecycle model:
--   company_status = 'active'         → live canonical company (default)
--                    'pending_review' → auto-created (backfill/onboarding),
--                                       awaiting admin blessing
--                    'merged'         → tombstone; merged_into_company_id set,
--                                       is_canonical = false
--   is_canonical           → fast boolean filter for "live" lookups
--   merged_into_company_id → canonical row a tombstone points at (redirect source)
--
-- Idempotent + additive. Existing rows default to active/canonical → no change
-- to current data.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS company_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS is_canonical boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS merged_into_company_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_merged_into_fkey') THEN
    ALTER TABLE companies
      ADD CONSTRAINT companies_merged_into_fkey
      FOREIGN KEY (merged_into_company_id) REFERENCES companies(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_company_status_check') THEN
    ALTER TABLE companies
      ADD CONSTRAINT companies_company_status_check
      CHECK (company_status IN ('active', 'pending_review', 'merged'));
  END IF;
END $$;

-- Admin review-queue filter (small partial index over the non-active rows).
CREATE INDEX IF NOT EXISTS companies_status_idx
  ON companies (company_status)
  WHERE company_status <> 'active';

-- Tombstone → canonical redirect lookups.
CREATE INDEX IF NOT EXISTS companies_merged_into_idx
  ON companies (merged_into_company_id)
  WHERE merged_into_company_id IS NOT NULL;
