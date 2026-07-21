-- Recommendation-engine versioning on generated batches.
--
-- Stamps every introduction_batches row with the algorithm version, scoring-model
-- version, a full config snapshot, and a deterministic config hash, so we can:
--   - compare historical batches and know exactly which algorithm produced one,
--   - reproduce historical results,
--   - evolve the algorithm safely and analyze performance across versions.
-- created_at already provides the generation timestamp.
--
-- Purely additive (nullable columns, IF NOT EXISTS) → backward-compatible and safe
-- to apply before OR after the code deploy. The code writes these columns when
-- present and degrades gracefully (records nothing) if the migration is not yet
-- applied, so ordering does not matter.

ALTER TABLE introduction_batches ADD COLUMN IF NOT EXISTS algorithm_version text;
ALTER TABLE introduction_batches ADD COLUMN IF NOT EXISTS scoring_model_version text;
ALTER TABLE introduction_batches ADD COLUMN IF NOT EXISTS algorithm_config jsonb;
ALTER TABLE introduction_batches ADD COLUMN IF NOT EXISTS config_hash text;
