-- 045 — Automatic calendar invitations: durable idempotency + lifecycle sequence.
--
-- (a) meetings.calendar_sequence — the RFC 5545 SEQUENCE for the meeting's calendar
--     event. 0 at first confirmation; incremented on each material update (reschedule)
--     or cancellation, so calendar clients apply updates to the ONE logical event.
--
-- (b) meeting_calendar_invites — the durable send/idempotency record (modeled on the
--     stripe_events INSERT-first pattern). A UNIQUE (meeting_id, method, sequence,
--     recipient_email) claim makes a double-click / server retry / webhook replay a
--     no-op, while a 'failed' row stays retryable and a 'sent' row is never re-sent.
--     Service-role only (RLS enabled, no policies) — it is operational metadata, never
--     read by members. No FK to meetings, so CANCEL records survive a hard-deleted meeting.
--
-- Prod-safe: additive, idempotent, non-destructive.

ALTER TABLE public.meetings
  ADD COLUMN IF NOT EXISTS calendar_sequence integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.meeting_calendar_invites (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id     uuid NOT NULL,
  method         text NOT NULL CHECK (method IN ('REQUEST', 'CANCEL')),
  sequence       integer NOT NULL DEFAULT 0,
  recipient_email text NOT NULL,
  status         text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'sent', 'failed')),
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, method, sequence, recipient_email)
);

-- Lookups by meeting (compute the next sequence, audit a meeting's sends).
CREATE INDEX IF NOT EXISTS meeting_calendar_invites_meeting_idx
  ON public.meeting_calendar_invites (meeting_id);

-- Service-role only: enable RLS with NO policies so the anon/authenticated roles can
-- never read or write it. The server writes via the service-role client (bypasses RLS).
ALTER TABLE public.meeting_calendar_invites ENABLE ROW LEVEL SECURITY;
