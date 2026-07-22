-- Participation flag: pause a member from matching without deactivating them.
--
-- `matching_paused = true` removes a member from ALL recommendation surfaces (they
-- can neither receive introductions nor be suggested as a candidate) while leaving
-- their account fully active in every other respect. This is the product-level,
-- broadly-applicable mechanism for "this profile should not currently participate
-- in matching" — a per-member, admin-togglable setting, NOT a hard-coded special
-- case. It is enforced by the canonical eligibility filter (lib/matching/eligibility.ts).
--
-- ORDERING: because the eligibility filter references this column in both its DB
-- query and its selected columns, this migration MUST be applied BEFORE deploying
-- the code that reads it. It is otherwise safe (nullable/defaulted, additive).

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS matching_paused boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN profiles.matching_paused IS
  'When true, the member is excluded from all matching/recommendation surfaces (canonical eligibility). Account remains otherwise active.';
