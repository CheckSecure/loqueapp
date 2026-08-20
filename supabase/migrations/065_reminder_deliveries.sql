-- 065_reminder_deliveries.sql
--
-- DURABLE DELIVERY LEDGER for the Wednesday unanswered-introduction reminder.
--
-- NOT YET APPLIED. Operator applies in the Supabase Dashboard after review.
-- Migrations 063 and 064 are applied and are NOT modified by this file.
--
-- ─── WHY A LEDGER, AND NOT THE NOTIFICATIONS TABLE ───────────────────────────────────────────────
-- The existing reminder dedupes on public.notifications via the partial unique index from migration
-- 006. That index is a fine dedupe authority, but a notification row proves only that a reminder was
-- CREATED — it says nothing about whether the provider accepted the message. There is no email
-- delivery log in this schema, so a provider failure today is indistinguishable from a success.
--
-- This mirrors the established public.invitation_deliveries pattern (migration 049): a coarse status
-- machine, the provider message id, and an error CLASS. It deliberately stores NO email body, NO
-- proposed-connection identity, NO raw provider payload and NO secret.
--
-- ─── THE CLAIM IS THE UNIQUE INDEX ───────────────────────────────────────────────────────────────
-- reminder_deliveries_active_claim_uniq is a PARTIAL unique index over the ACTIVE states. A worker
-- claims by INSERT; a second concurrent worker's insert raises 23505 and it skips. That is the whole
-- concurrency control — no advisory lock, no lease timestamp to expire, nothing to reconcile.
--
-- 'failed' is deliberately OUTSIDE the partial index, so a provider failure can be re-claimed.
--
-- ─── THE CLAIM IS A LEASE, NOT A TOMBSTONE ───────────────────────────────────────────────────────
-- An earlier draft kept 'claimed' forever. A worker that crashed between claiming and calling the
-- provider would then block that member's reminder for the whole week — a silent, permanent miss.
--
-- 'claimed' now carries claimed_at and is reclaimable after CLAIM_LEASE (conservatively 15 minutes,
-- far longer than any single send). A FRESH claim can never be stolen: reclaiming updates only rows
-- whose claimed_at is older than the lease, so two concurrent workers cannot both proceed.
--
-- 'accepted' is NEVER reclaimable. Once the provider may have taken the message we default to
-- preventing duplicates, even at the cost of a missed reminder.
--
-- HONEST DELIVERY SEMANTICS. This is AT-MOST-ONCE with an ambiguous boundary, not exactly-once. If
-- the process dies during the provider call, the row stays 'claimed' with a stale claimed_at and a
-- later run may re-send — the one window in which a duplicate is possible. The lease is set long
-- enough that this requires a genuine crash mid-call, and the alternative (never reclaiming) means
-- guaranteed permanent misses. No code path here claims exactly-once delivery.

CREATE TABLE IF NOT EXISTS public.reminder_deliveries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- One purpose today; the column exists so a future reminder cannot collide with this one.
  purpose             text NOT NULL CHECK (purpose IN ('wednesday_intro_reminder')),
  -- ISO week computed from the AMERICA/NEW_YORK calendar date, e.g. '2026-W34'.
  cycle_key           text NOT NULL,
  -- How many open cards the member held when claimed. Aggregate signal only; no identities.
  open_card_count     integer NOT NULL DEFAULT 0 CHECK (open_card_count >= 0),
  provider_message_id text NULL,
  status              text NOT NULL DEFAULT 'claimed'
                       CHECK (status IN ('claimed','accepted','delivered','deferred',
                                         'bounced','blocked','complained','failed')),
  -- Coarse class only (e.g. 'provider_error', 'rate_limited'). NEVER a raw provider message.
  error_class         text NULL,
  -- Lease start. A 'claimed' row older than the lease may be reclaimed; see the header.
  claimed_at          timestamptz NOT NULL DEFAULT now(),
  attempts            integer NOT NULL DEFAULT 1 CHECK (attempts >= 0),
  accepted_at         timestamptz NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- THE CLAIM. At most one ACTIVE attempt per member per purpose per week.
CREATE UNIQUE INDEX IF NOT EXISTS reminder_deliveries_active_claim_uniq
  ON public.reminder_deliveries (member_id, purpose, cycle_key)
  WHERE status IN ('claimed', 'accepted', 'delivered', 'deferred');

-- Idempotent webhook application, when one is added later. Unique only when present.
CREATE UNIQUE INDEX IF NOT EXISTS reminder_deliveries_provider_msg_uniq
  ON public.reminder_deliveries (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS reminder_deliveries_member_idx ON public.reminder_deliveries (member_id);
CREATE INDEX IF NOT EXISTS reminder_deliveries_cycle_idx  ON public.reminder_deliveries (cycle_key, status);
-- Stale-claim recovery scans by (status, claimed_at).
CREATE INDEX IF NOT EXISTS reminder_deliveries_stale_idx  ON public.reminder_deliveries (status, claimed_at);

COMMENT ON TABLE public.reminder_deliveries IS
  'Durable Wednesday reminder delivery tracking (service-role only). Stores NO email body, connection identity, raw provider payload or secret — only a coarse status, the provider message id, an error class, and an aggregate open-card count. The partial unique index on the active states IS the claim: a concurrent second worker gets 23505 and skips.';

-- Service-role only. RLS is enabled with no policy, so PostgREST reaches it for no browser role;
-- the service key bypasses RLS. Members can never read another member's reminder history.
ALTER TABLE public.reminder_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.reminder_deliveries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.reminder_deliveries TO service_role;
