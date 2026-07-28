-- Warm-recommendation ("Contacted") step for member nominations.
--
-- Adds two timestamps to the existing waitlist table so the founder can send a
-- warm recommendation-introduction email (before any account provisioning) and
-- track that "Contacted" state. This does NOT change the invite/provisioning flow:
-- the temp-password invite (send-invite → sendReferralInviteEmail) still happens
-- later, unchanged. The new 'contacted' status value is a plain string written by
-- the app (waitlist.status is free-text — 'approved'/'invited'/'declined' are all
-- set by app code with no CHECK), so no enum/constraint change is needed.
--
-- OPERATOR VERIFICATION (one-time, before enabling the Contacted flow): the base
-- waitlist table is managed in the Supabase Dashboard, so the repo cannot prove
-- the absence of a CHECK. Confirm there is none on `status` (else 'contacted'
-- writes would fail). Quick check in the SQL editor:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'public.waitlist'::regclass AND contype = 'c';
-- Expect zero rows constraining `status` (the app already writes pending/approved/
-- invited/declined freely, so this is expected to be clean).
--
-- Additive + nullable + idempotent: ADD COLUMN IF NOT EXISTS. Existing rows keep
-- NULL and are unaffected. Production-safe: no rewrite, no destructive operation.

ALTER TABLE public.waitlist
  ADD COLUMN IF NOT EXISTS contacted_at                  timestamptz,
  ADD COLUMN IF NOT EXISTS recommendation_email_sent_at  timestamptz;

COMMENT ON COLUMN public.waitlist.recommendation_email_sent_at IS
  'When the founder sent the warm recommendation-introduction email (pre-provisioning). NULL = not yet contacted. Distinct from invited_at, which marks the temp-password access invite.';
COMMENT ON COLUMN public.waitlist.contacted_at IS
  'When the nomination moved to the Contacted state (set alongside recommendation_email_sent_at). NULL for rows that were never warm-contacted.';
