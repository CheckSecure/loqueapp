/**
 * lib/email/sendErrors.ts — what a failed send actually was.
 *
 * Kept OUT of lib/email.ts on purpose: that module constructs the Resend client at import time
 * (`new Resend(process.env.RESEND_API_KEY)`), so anything importing it needs a live API key. The
 * classification is pure, so it lives here where a test — and any caller that only needs to
 * interpret an outcome — can reach it without a provider.
 *
 * ─── WHY THESE THREE CLASSES ──────────────────────────────────────────────────────────────────
 * On 2026-09-09 every one of 81 failed Wednesday reminders was persisted as the literal
 * 'provider_error', because the sender tested the provider's error object for truthiness and threw
 * it away. A rate limit and a rejected address were indistinguishable afterwards, so the outage
 * could not be diagnosed from the ledger at all.
 */

export type EmailSendErrorClass = 'rate_limited' | 'provider_error' | 'uncertain'

/**
 * An error that carries its class, so a caller persists what happened instead of a hardcoded string.
 *
 *   'rate_limited'   the provider REFUSED because we sent too fast. Retryable, after a backoff.
 *   'provider_error' the provider RESPONDED with a definite rejection — bad address, rejected
 *                    payload, server error. Retrying the same message unchanged will not help.
 *   'uncertain'      no response at all: the request itself threw (network, abort, timeout). The
 *                    message MAY already have been accepted, so the caller must NOT record a
 *                    failure — see lib/reminders/deliveryLedger.ts markFailed. A missed reminder is
 *                    recoverable; a duplicate one is not.
 */
export class EmailSendError extends Error {
  constructor(readonly errorClass: EmailSendErrorClass) {
    super(errorClass)
    this.name = 'EmailSendError'
  }
}

/**
 * Classify a Resend error OBJECT — i.e. the provider answered and said no.
 *
 * Same rule sendSecureInviteEmail and sendNominationInviteEmail already applied, widened to read the
 * status code and the error name as well as the message: a 429 does not always spell "rate" in prose.
 */
export function classifyResendError(error: any): Exclude<EmailSendErrorClass, 'uncertain'> {
  const status = error?.statusCode ?? error?.status ?? ''
  if (String(status) === '429') return 'rate_limited'
  const text = `${error?.name ?? ''} ${error?.message ?? ''} ${status}`
  return /rate|limit|too many|429/i.test(text) ? 'rate_limited' : 'provider_error'
}

/**
 * One safe log line per failed send: the three fields needed to tell a 429 from a 422, and nothing
 * else. No recipient address, no subject, no body, no token, no API key. The message is truncated
 * because a provider can echo arbitrary length back.
 */
export function logSendFailure(scope: string, errorClass: EmailSendErrorClass, error: any): void {
  console.error(`[${scope}] send failed`, JSON.stringify({
    class: errorClass,
    status: error?.statusCode ?? error?.status ?? null,
    name: error?.name ?? null,
    message: typeof error?.message === 'string' ? error.message.slice(0, 200) : null,
  }))
}
