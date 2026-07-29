-- 032_profiles_company_id.sql
-- Phase 2 — profiles.company_id: nullable FK to the canonical company entity.
--
-- profiles.company (free text) STAYS PERMANENTLY as raw user input and the input
-- to (re-)resolution. company_id is a DERIVED pointer, populated by the backfill
-- job (scripts/backfill-company-ids.ts) and later by onboarding. There is
-- intentionally NO NOT NULL / enforcement planned — free text + fuzzy resolution
-- always covers the tail, and ON DELETE SET NULL means merging/deleting a company
-- can never orphan or error a profile.
--
-- company_resolution records HOW the link was made; it drives the future admin
-- review queue (pending_review / unresolved need a human) and the auto-vs-manual
-- trust distinction.
--
-- No read path depends on these yet (shadow-write only). Additive + nullable.
-- Idempotent: ADD COLUMN IF NOT EXISTS + guarded constraints/indexes.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS company_id uuid,
  ADD COLUMN IF NOT EXISTS company_resolution text,
  ADD COLUMN IF NOT EXISTS company_resolved_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_company_id_fkey') THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_company_resolution_check') THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_company_resolution_check
      CHECK (company_resolution IS NULL OR company_resolution IN
        ('exact', 'canonical', 'fuzzy', 'manual', 'unresolved', 'pending_review'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS profiles_company_id_idx
  ON profiles (company_id);

-- Review-queue filter: profiles whose company link needs a human.
CREATE INDEX IF NOT EXISTS profiles_company_resolution_idx
  ON profiles (company_resolution)
  WHERE company_resolution IN ('pending_review', 'unresolved');
