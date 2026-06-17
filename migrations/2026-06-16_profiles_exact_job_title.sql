-- Andrel | profiles.exact_job_title text capture | 2026-06-16
-- Phase D — additive, reversible. Captures the user's literal job title for
-- display, distinct from `title` (read by scoring.ts completeness + trust
-- signals) and `role_type` (the structured matching key — must stay in
-- ROLE_CATEGORIES or the legacy set).
--
-- Display rule (Phase D):
--   exact_job_title || role_type
-- on user-visible cards. NULL = "fall back to role_type"; no backfill needed.
--
-- This column is NOT read by any matching/scoring/trust path. Adding it cannot
-- affect calculateAlignmentScore, scoreHiring, vertical-boost, match-signals,
-- scoring.ts, or trust/signals.ts.

ALTER TABLE profiles ADD COLUMN exact_job_title text;

-- Rollback (if needed):
--   ALTER TABLE profiles DROP COLUMN exact_job_title;
