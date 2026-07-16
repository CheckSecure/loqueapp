-- Case-insensitive uniqueness for waitlist emails.
--
-- Registration now normalizes emails to trim().toLowerCase() before insert, and
-- checks case-insensitively for an existing waitlist row / profile / auth user.
-- This index is the durable DB-level backstop so a case-variant duplicate (e.g.
-- "Sonali.Gunawardhana@bd.com" vs "sonali.gunawardhana@bd.com") can never be
-- inserted again.
--
-- DO NOT APPLY until the existing case-variant duplicate has been cleaned up —
-- creating this index while two rows share lower(email) will FAIL. Apply the
-- narrowly-scoped Sonali cleanup first (retain 95a858c9…, delete b6acea66…),
-- then run this migration.
--
-- Idempotent: IF NOT EXISTS makes repeated runs safe once the data is clean.

CREATE UNIQUE INDEX IF NOT EXISTS waitlist_email_lower_uniq
  ON public.waitlist (lower(email));
