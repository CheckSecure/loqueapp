-- Referrer consent to be named when the recommended person is contacted.
--
-- The warm recommendation email and the official invite email can name the
-- referring member ("<Name> recommended you…"). This adds an explicit, per-referral
-- consent flag so that NEVER happens unless the referring member opted in. Default
-- FALSE means: existing referrals (and any new one where the member did not tick the
-- box) are treated as "no consent" — the invite flow falls back to the anonymous
-- "A founding member of Andrel recommended you" phrasing.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS). NOT NULL DEFAULT false is a
-- constant default, so existing rows are backfilled to false WITHOUT a table rewrite
-- (Postgres 11+). Production-safe: no destructive operation.
--
-- Until applied, the referral submit route fails open (retries the insert WITHOUT
-- this column), and BOTH invite flows read the flag as absent → treat as no consent
-- (private). The referral campaign send route REFUSES to run until this column
-- exists, because the campaign email promises the consent choice will be honored.

ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS referrer_consent_to_share boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.referrals.referrer_consent_to_share IS
  'TRUE only when the referring member explicitly consented to being named when the recommended person is contacted. Default/absent = no consent: the invite flow uses anonymous phrasing.';
