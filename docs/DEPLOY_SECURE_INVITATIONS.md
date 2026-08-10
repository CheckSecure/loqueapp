# Secure Invitations — Gated Rollout Runbook

Secure, passwordless invitations with durable delivery tracking, a Resend delivery webhook, and a
three-mode rollout gate. This runbook is the ONLY supported enablement path.

## Rollout mode (server-side gate)

`INVITATIONS_MODE` (default `off` — anything unset/empty/malformed/unknown parses to `off`):

| Mode  | Single invite / access resend | Bulk execute | Activation reminders | Password reset |
|-------|-------------------------------|--------------|----------------------|----------------|
| `off`  | blocked (503 paused)         | rejected (503) | paused             | available (separate) |
| `test` | allowlisted recipients only  | allowlisted rows only; others skipped | paused | available |
| `on`   | normal                       | normal        | may run             | available |

`INVITATION_TEST_EMAILS` — comma-separated recipients allowed in `test` mode. Addresses are
normalized with the same normalizer as login; empty/malformed → no recipients allowed. Never logged.

Enforcement is **server-side only**; the admin UI banner ("Invitation test mode") is informational.
Password reset is a **separate** path and is unaffected by the mode. The legacy
`/api/admin/waitlist/send-invite` route remains **410 Gone**.

## Deployment order

1. **Commit locally.**
2. **Apply migration `049_invitation_deliveries.sql`** from the committed SQL (Supabase dashboard).
   Until applied, the pre-send claim fails closed and sends are unavailable (never sent-untracked).
3. **Push and deploy with `INVITATIONS_MODE=off`.**
4. **Create the Resend webhook** pointing at `POST /api/webhooks/resend` (subscribe to
   `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`,
   `email.failed`, `email.suppressed`).
5. **Store `RESEND_WEBHOOK_SECRET` in Vercel and redeploy.**
6. **Verify webhook endpoint behavior**: a missing/invalid signature → 401; a valid unknown-message
   event → retryable 500 (until the delivery row exists); a malformed timestamp → 200 ack, no state
   change. No raw body/headers/secret are logged.
7. **Set `INVITATIONS_MODE=test`** and set exactly **one controlled** address in
   `INVITATION_TEST_EMAILS`.
8. **Redeploy.**
9. **Send one secure invitation** to that controlled address from the admin waitlist.
10. **Verify the full path**: provider accepted → `delivered` webhook → secure link email →
    deliberate recovery click → password set → sign-in → onboarding (founding metadata if set).
11. **If any step fails, return `INVITATIONS_MODE=off` immediately.**
12. **Only after review, set `INVITATIONS_MODE=on`.**
13. **Resume approvals / normal invitations.**

## Invariants (never regress)

- No send without a durable pre-send claim (fail closed).
- One idempotency key ⇄ one token/payload; uncertain sends are never re-sent under the same key.
- `deferred`/`accepted`/`claimed` are in-flight and block a blind resend; past the 24h review window
  an unresolved attempt needs explicit admin review to start a new attempt (new row/token/key).
- Webhook processing is replay-safe (`svix_id`) and recoverable after a partial DB failure
  (retryable event results); unknown-message events are retryable, never ack-and-lose.
- `invitation_deliveries` / `invitation_delivery_events` are service-role only (RLS, no policies);
  no token/link/password/body/raw payload is stored or logged.
