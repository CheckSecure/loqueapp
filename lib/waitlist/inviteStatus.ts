// ONE shared admin invitation-state model, derived from durable delivery records + the
// waitlist lifecycle. Used by the server page (compute) and the client (render) so there is
// no competing status logic. Pure + unit-tested. Carries NO recipient address, token, link,
// provider payload, or raw error — only a coarse key + admin-safe copy + action flags.

// Resend retains idempotency keys for 24h. An unresolved (uncertain) send is NEVER retried under
// its key with a regenerated token — that changes the payload and returns 409
// invalid_idempotent_request. Within the window we do nothing (wait for the delivery webhook);
// PAST it, an explicit admin review can retire the claim and start a NEW attempt (new row/token/key).
export const INVITE_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000

export type InviteStatusKey =
  | 'activated'
  | 'not_sent'        // reinstated / never sent  → "Invitation not sent"
  | 'sending'         // claimed, within window → "Delivery status pending" (DO NOT resend)
  | 'stale'           // claimed, PAST window → unconfirmed; explicit review + new attempt
  | 'accepted'        // provider accepted (NOT delivered)
  | 'delivered'
  | 'deferred'
  | 'bounced'
  | 'blocked'         // suppressed
  | 'complained'
  | 'failed'          // definite failure → safe retry
  | 'unavailable'     // invited historically, no durable delivery record

export type InviteTone = 'neutral' | 'info' | 'positive' | 'warning' | 'danger'

export interface InviteStatusModel {
  key: InviteStatusKey
  label: string
  tone: InviteTone
  tooltip: string
  /** blind resend allowed (a fresh secure link) */
  canResend: boolean
  /** explicit safe retry (definite failure) */
  canRetry: boolean
  /** delivered-but-inactive: resend allowed only AFTER confirmation */
  needsConfirmResend: boolean
  /** activated → no invitation action at all */
  noAction: boolean
}

/** Latest meaningful delivery attempt for a waitlist row (coarse status only). */
export interface DeliveryLite {
  status: string | null
  /** when the attempt was claimed — used to age a stuck `claimed` past the retry window. */
  attemptedAt?: string | null
  /** the send had additional recipients (CC/BCC): the provider cannot attribute delivery events
   *  per-mailbox, so this row is FROZEN at provider-accepted and is never auto-resent. */
  hasAdditionalRecipients?: boolean
}

const M = (
  key: InviteStatusKey, label: string, tone: InviteTone, tooltip: string,
  o: Partial<Pick<InviteStatusModel, 'canResend' | 'canRetry' | 'needsConfirmResend' | 'noAction'>> = {},
): InviteStatusModel => ({
  key, label, tone, tooltip,
  canResend: o.canResend ?? false, canRetry: o.canRetry ?? false,
  needsConfirmResend: o.needsConfirmResend ?? false, noAction: o.noAction ?? false,
})

/**
 * Derive the admin-safe invitation state. Precedence: activated → durable delivery record →
 * reinstated/never-sent → invited-without-record (historical unavailable).
 *
 * `invited_at` ALONE never means "Delivered" — only a durable `delivered` event does.
 */
export function inviteStatusModel(args: {
  waitlistStatus: string
  invitedAt: string | null
  profileComplete: boolean
  delivery: DeliveryLite | null
  /** current time for aging a stuck claim; defaults to Date.now() (server-side callers pass it). */
  nowMs?: number
}): InviteStatusModel {
  if (args.profileComplete) {
    return M('activated', 'Activated', 'positive', 'This member has completed onboarding. No invitation action.', { noAction: true })
  }

  const s = args.delivery?.status ?? null

  // MULTI-RECIPIENT (CC/BCC) invite: the provider cannot attribute delivery events per-mailbox, so this
  // send is FROZEN at provider-accepted (webhook fail-safe). Show that honestly and NEVER offer resend/
  // retry (a resend would re-mail the nominee AND re-CC the extra recipient). Takes precedence over the
  // in-flight aging below so it never ages into a "review needed / resend" state.
  if (s && args.delivery?.hasAdditionalRecipients) {
    return M('accepted', 'Accepted by provider', 'info',
      'Accepted by provider. Recipient-level delivery is unavailable because the invitation included a CC (the provider cannot confirm delivery per-mailbox). Do not automatically resend — review manually if the recipient reports no email.')
  }

  if (s) {
    // In-flight statuses (claimed/accepted/deferred) age into a review window. WITHIN it: DO NOT
    // resend (a lost webhook resolves, or the send is still pending); a same-key re-send with a
    // regenerated token would be a 409 invalid_idempotent_request. PAST it: an explicit
    // admin-reviewed new attempt is allowed (force → new row/token/key).
    const inFlight = s === 'claimed' || s === 'accepted' || s === 'deferred'
    if (inFlight) {
      const attempted = args.delivery?.attemptedAt ? Date.parse(args.delivery.attemptedAt) : NaN
      const now = args.nowMs ?? Date.now()
      const pastWindow = Number.isFinite(attempted) && (now - attempted) >= INVITE_RETRY_WINDOW_MS
      if (pastWindow) {
        return M('stale', 'Unconfirmed—review needed', 'warning',
          'A previous send is unresolved and past the review window (delivery never confirmed). Review, then confirm a NEW attempt (new secure link). Do not resend before reviewing.',
          { needsConfirmResend: true })
      }
    }
    switch (s) {
      case 'claimed':
        return M('sending', 'Delivery status pending', 'info',
          'Awaiting the provider delivery result. Do NOT resend — it resolves automatically (or becomes reviewable after 24 hours). No action needed.')
      case 'accepted':
        return M('accepted', 'Accepted by provider', 'info',
          'The provider accepted the request (NOT proof of inbox delivery). Awaiting a delivery event — do NOT resend.')
      case 'delivered':
        // Delivered but still inactive (profileComplete handled above) → confirm before a new link.
        return M('delivered', 'Delivered', 'positive', 'The provider reports the email was delivered. Not the same as opened. If they still need access, send a new secure link.', { needsConfirmResend: true })
      case 'deferred':
        return M('deferred', 'Deferred—delivery pending', 'info',
          'The provider temporarily delayed delivery and will retry. Still in flight — do NOT resend (reviewable after 24 hours). No action needed yet.')
      case 'bounced':
        return M('bounced', 'Bounced', 'danger', 'The address hard-bounced. Do NOT resend until the address is corrected/verified.')
      case 'blocked':
        return M('blocked', 'Suppressed / blocked', 'danger', 'On the provider suppression list (prior bounce/complaint). Blind resend is disabled — review the address first.')
      case 'complained':
        return M('complained', 'Complained', 'danger', 'The recipient marked a prior email as spam. Do NOT resend without review.')
      case 'failed':
        // Definite provider rejection BEFORE acceptance. `failed` leaves the active-claim index, so
        // a retry starts a NEW attempt (new claim → new row, token, and idempotency key).
        return M('failed', 'Failed—retry available', 'warning', 'A definite send failure. A retry starts a new attempt (new secure link) — safe to retry.', { canRetry: true })
      default:
        return M('unavailable', 'Delivery status unavailable', 'neutral', 'No durable delivery record is available for this attempt.', { canResend: true })
    }
  }

  // No durable delivery record.
  if (args.waitlistStatus === 'invited' && args.invitedAt) {
    return M('unavailable', 'Delivery status unavailable', 'neutral',
      'This invitation predates durable delivery tracking, so its provider outcome is unknown. Send a new secure link if needed.', { canResend: true })
  }
  // Reinstated or never sent (status invited, invited_at null).
  return M('not_sent', 'Invitation not sent', 'warning',
    'No invitation has been sent yet. Use “Send invitation” — no email has gone out.', { canResend: true })
}
