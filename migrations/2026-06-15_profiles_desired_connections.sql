-- Andrel | profiles.desired_connections jsonb capture | 2026-06-15
-- Phase C — additive, reversible. Captures the user's "who do you want to
-- meet" preference as a structured map: { [category]: string[] }.
--
-- Storage shape (enforced in code via lib/role-taxonomy.validateSelection):
--   {} ............... no preference set
--   { Legal: [] } .... whole Legal category ("Anyone in Legal")
--   { Legal: ["General Counsel", "Chief Legal Officer"] } ... specific titles
--
-- Phase C does NOT read this column anywhere in a scoring/ranking path. The
-- column is capture-only until a later phase wires the matcher.
-- NOT NULL DEFAULT '{}'::jsonb so existing rows are uniformly "unset" without
-- a backfill step.

ALTER TABLE profiles
  ADD COLUMN desired_connections jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Rollback (if needed):
--   ALTER TABLE profiles DROP COLUMN desired_connections;
