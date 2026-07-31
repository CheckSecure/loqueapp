-- One-time member referral-campaign dedupe marker.
--
-- Adds a single nullable timestamp to profiles so the "Help us grow the Andrel
-- network" campaign is fully idempotent and resumable: the send route treats a
-- non-NULL value as "already sent" and skips the row, and it stamps this column
-- ONLY after the email provider (Resend) accepts the message. A failed send
-- leaves it NULL, so a re-run retries exactly the un-sent members and never
-- double-sends. This is the SOLE source of truth for campaign de-duplication.
--
-- Additive + nullable + idempotent (ADD COLUMN IF NOT EXISTS). Existing rows keep
-- NULL and are unaffected. Production-safe: no rewrite, no destructive operation.
-- Until applied, the campaign code fails open (eligibility treats the column as
-- absent → everyone looks un-sent) — so DO NOT run the campaign before applying.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS referral_campaign_sent_at timestamptz;

COMMENT ON COLUMN public.profiles.referral_campaign_sent_at IS
  'When the one-time "Help us grow the Andrel network" referral-campaign email was successfully sent to this member. NULL = not yet sent; the campaign skips non-NULL rows (idempotent, resumable dedupe).';
