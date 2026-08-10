-- 049 — Durable invitation-delivery tracking.
--
-- WHY: today `invited_at` only means "Resend accepted the request" and there is NO record
-- of actual delivery/bounce/complaint. This table is the delivery TRUTH: one row per send
-- attempt, updated by the Resend webhook. The pre-send code FAILS CLOSED: until this table
-- exists and is writable, NO invitation is sent (no token, no Auth mutation, no provider call,
-- no invited_at) — invitations are UNAVAILABLE, never sent-untracked.
--
-- PRIVACY / SECURITY: service-role ONLY (RLS enabled, NO policies → anon/authenticated can
-- never read or write it). It stores NO secret material — never a token, link, password,
-- email body, or raw provider payload; only a coarse status, the provider message id, and a
-- coarse error class. History is preserved (one row per attempt; terminal states never
-- regress — enforced in code).
--
-- Prod-safe: additive, idempotent, non-destructive.

CREATE TABLE IF NOT EXISTS public.invitation_deliveries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waitlist_id         uuid NULL,                 -- no FK: a delivery record must survive row edits
  auth_user_id        uuid NULL,
  recipient_email     text NOT NULL,             -- normalized (lower+trim), same as login; masked in UI
  purpose             text NOT NULL CHECK (purpose IN ('first_invite','access_resend','reminder')),
  provider            text NOT NULL DEFAULT 'resend',
  provider_message_id text NULL,                 -- Resend id; UNIQUE when present (idempotent webhook)
  status              text NOT NULL DEFAULT 'claimed'
                       CHECK (status IN ('claimed','accepted','delivered','deferred','bounced','blocked','complained','failed')),
  attempt_number      integer NOT NULL DEFAULT 1,
  error_class         text NULL,                 -- coarse only ('rate_limited'|'provider_error'|'bounced'|…); never raw payload
  attempted_at        timestamptz NOT NULL DEFAULT now(),
  accepted_at         timestamptz NULL,
  delivered_at        timestamptz NULL,
  failed_at           timestamptz NULL,
  last_event_at       timestamptz NULL,        -- created_at of the last applied webhook event (ordering guard)
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Provider message id is the webhook's join key — unique when present (partial index allows
-- multiple NULLs for attempts that never reached the provider).
CREATE UNIQUE INDEX IF NOT EXISTS invitation_deliveries_provider_msg_uniq
  ON public.invitation_deliveries (provider_message_id) WHERE provider_message_id IS NOT NULL;

-- Lookups by waitlist row (admin status column) and recipient (latest-attempt reconciliation).
CREATE INDEX IF NOT EXISTS invitation_deliveries_waitlist_idx  ON public.invitation_deliveries (waitlist_id);
CREATE INDEX IF NOT EXISTS invitation_deliveries_recipient_idx ON public.invitation_deliveries (recipient_email);

-- PRE-SEND ATOMIC CLAIM: at most ONE active/in-flight attempt per (waitlist_id, purpose). A
-- concurrent second click hits this unique index (23505) and safely no-ops onto the existing
-- claim, so two requests produce ONE provider send. 'deferred' is INCLUDED because a delayed
-- email is still in flight and must block another blind send. A terminal row (delivered/bounced/
-- blocked/complained/failed) leaves the partial index so an explicit reviewed retry can re-claim.
CREATE UNIQUE INDEX IF NOT EXISTS invitation_deliveries_active_claim_uniq
  ON public.invitation_deliveries (waitlist_id, purpose)
  WHERE status IN ('claimed', 'accepted', 'deferred') AND waitlist_id IS NOT NULL;

-- Service-role only: enable RLS with NO policies so anon/authenticated can never touch it.
ALTER TABLE public.invitation_deliveries ENABLE ROW LEVEL SECURITY;

-- ── Webhook event log — replay + ordering safety (service-role only) ───────────
-- Resend delivers at-least-once and possibly out-of-order. We claim each svix_id BEFORE
-- applying it (unique → duplicate is a safe no-op) and keep an auditable history. Stores NO
-- payload/body/token/link/secret — only ids, event type, timestamps, and a coarse result.
CREATE TABLE IF NOT EXISTS public.invitation_delivery_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  svix_id             text NOT NULL UNIQUE,      -- webhook delivery id (idempotency key)
  provider_message_id text NULL,
  event_type          text NOT NULL,
  event_created_at    timestamptz NOT NULL,      -- PROVIDER event time; REQUIRED for deterministic
                                                 -- state ordering. We NEVER substitute local receipt
                                                 -- time: an event without a valid provider timestamp
                                                 -- is rejected upstream and never inserted here.
  received_at         timestamptz NOT NULL DEFAULT now(),  -- local receipt (audit only; NOT ordering)
  -- Processing result. RETRYABLE (a partial failure Resend should redeliver): 'received','error',
  -- 'not_found'. TERMINAL (a completed duplicate on redelivery): 'applied','ignored'. On a duplicate
  -- svix_id the app re-applies unless the prior result is terminal — so a mid-apply crash recovers.
  result              text NOT NULL DEFAULT 'received'
                       CHECK (result IN ('received','applied','ignored','not_found','duplicate','error')),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invitation_delivery_events_msg_idx ON public.invitation_delivery_events (provider_message_id);
ALTER TABLE public.invitation_delivery_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.invitation_delivery_events IS
  'Webhook event log (service-role only). One row per svix_id (unique → idempotent replay). Stores NO payload/body/token/link/secret — ids + type + timestamps + coarse result only.';

COMMENT ON TABLE public.invitation_deliveries IS
  'Durable invitation delivery tracking (service-role only). Delivery truth, updated by the Resend webhook. Stores NO token/link/password/email-body/raw-payload — only coarse status + provider message id + error class. Terminal states (delivered/bounced/blocked/complained) never regress (enforced in code).';
