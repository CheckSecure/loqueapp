-- Migration: stripe_events idempotency table
-- Date: 2026-05-08
-- Purpose: Prevent double-processing of Stripe webhook events.
--
-- Both webhook handlers (/api/stripe/webhook and /api/webhooks/stripe) will
-- insert event_id on first receipt and early-exit with 200 if the row already
-- exists. This guards against Stripe's at-least-once delivery guarantee.
--
-- RLS is intentionally DISABLED on this table. Both webhook handlers run under
-- createAdminClient() which uses the service-role key and bypasses RLS
-- regardless. Enabling RLS here adds no security benefit and creates a footgun
-- if the key context ever changes — the handler would silently fail to insert
-- and lose idempotency protection. Server-side-only table; no user-facing
-- access is ever needed.

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id     TEXT        PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stripe_events_processed_at_idx
  ON stripe_events (processed_at);

-- RLS explicitly off (default for new tables in Supabase, stated here for
-- documentation purposes — do not enable without updating webhook handlers).
ALTER TABLE stripe_events DISABLE ROW LEVEL SECURITY;
