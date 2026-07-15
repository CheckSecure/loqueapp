-- Race-proof idempotency for per-entity notifications (e.g. exactly one
-- 'message_received' notification per message id).
--
-- createNotificationSafe() already does a pre-insert dedupe check, but a
-- select-then-insert can still race under two concurrent identical requests.
-- This partial unique index makes the database the final arbiter: a concurrent
-- duplicate insert raises 23505, which the application treats as a successful
-- no-op.
--
-- Partial (WHERE data->>'dedupeKey' IS NOT NULL AND <> '') so ONLY notifications
-- carrying a dedupe key are constrained. Legacy/digest notifications (no
-- dedupeKey) and all existing rows are unaffected — and since no existing row
-- has a dedupeKey yet, index creation matches zero rows and cannot fail on
-- pre-existing data.
--
-- Idempotent: IF NOT EXISTS makes repeated runs safe.

CREATE UNIQUE INDEX IF NOT EXISTS notifications_user_type_dedupe_key_uniq
  ON public.notifications (user_id, type, (data->>'dedupeKey'))
  WHERE data->>'dedupeKey' IS NOT NULL AND data->>'dedupeKey' <> '';
