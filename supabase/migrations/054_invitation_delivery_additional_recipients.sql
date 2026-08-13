-- 054 — Minimal multi-recipient marker on invitation_deliveries (webhook fail-safe).
--
-- WHY: an invitation may CC/BCC an additional mailbox on the SAME message (e.g. a nomination that CC's
-- the nominator), so multiple recipients share ONE Resend message_id. Resend's webhook is MESSAGE-level
-- and does NOT reliably attribute a delivered/bounced/complained/failed/blocked event to a specific
-- mailbox on a multi-recipient message. Applying such an event by message id alone would let an extra
-- recipient's bounce mark the primary recipient bounced, or an extra recipient's delivery mark the
-- primary delivered. This boolean records ONLY the general fact that the send had additional recipients
-- (no CC/BCC ADDRESS is stored). When true, the webhook applier FAILS SAFE — it preserves the
-- provider-'accepted' state, never changes the primary recipient's state from an ambiguous event, and
-- never triggers a resend. Existing rows default false → unchanged single-recipient behavior.
--
-- Additive, idempotent, non-destructive. Migration 048 and all other objects untouched.

ALTER TABLE public.invitation_deliveries
  ADD COLUMN IF NOT EXISTS has_additional_recipients boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.invitation_deliveries.has_additional_recipients IS
  'True when the send included additional recipients (CC/BCC) sharing one provider message. NO address is stored. When true the Resend webhook applier FAILS SAFE (delivery state frozen at provider-accepted, no resend) because Resend cannot attribute events per-mailbox.';
