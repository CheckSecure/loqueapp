import { Resend } from 'resend'

// Webhook verification via the OFFICIAL Resend SDK (`resend.webhooks.verify`), which performs
// Svix signature verification internally. No custom cryptography. The pure event→status +
// ordering helpers stay here so they are unit-testable in node.

export type DeliveryStatus =
  | 'claimed' | 'accepted' | 'delivered' | 'deferred' | 'bounced' | 'blocked' | 'complained' | 'failed'

// Resend event → our coarse delivery status (exact Resend event names). Unknown → null (ignored).
const EVENT_TO_STATUS: Record<string, DeliveryStatus> = {
  'email.sent': 'accepted',            // provider accepted — NOT delivery
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'deferred',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
  'email.suppressed': 'blocked',       // on the account suppression list
}

export function mapResendEvent(type: string | null | undefined): DeliveryStatus | null {
  return (type && EVENT_TO_STATUS[type]) || null
}

// Terminal delivery outcomes — never regress to an earlier state (out-of-order events).
const TERMINAL: ReadonlySet<DeliveryStatus> = new Set<DeliveryStatus>(['delivered', 'bounced', 'blocked', 'complained'])
export function isTerminal(s: string | null | undefined): boolean {
  return !!s && TERMINAL.has(s as DeliveryStatus)
}

const RANK: Record<DeliveryStatus, number> = {
  claimed: 0, accepted: 1, deferred: 1, failed: 2, delivered: 3, bounced: 3, blocked: 3, complained: 3,
}
/** Should `next` be written over `current`? False when current is terminal or outranks next. */
export function shouldApplyStatus(current: string | null | undefined, next: DeliveryStatus): boolean {
  if (!current) return true
  if (isTerminal(current)) return false
  return (RANK[next] ?? 0) >= (RANK[current as DeliveryStatus] ?? 0)
}

export interface VerifiedWebhookEvent {
  type: string
  messageId: string | null
  createdAt: string | null
}

let _resend: Resend | null = null
function resendClient(): Resend {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY)
  return _resend
}

/**
 * Verify a Resend webhook with the OFFICIAL SDK and return the SAFE subset we use (type +
 * provider message id + created_at). Returns null when verification throws (invalid / missing
 * signature) — the caller MUST treat null as an invalid webhook. Never logs the body/headers/
 * secret. `client` is injectable for tests (defaults to the shared instance).
 */
export function verifyResendWebhook(
  rawBody: string,
  headers: Headers,
  webhookSecret: string,
  client: Pick<Resend, 'webhooks'> = resendClient(),
): VerifiedWebhookEvent | null {
  if (!webhookSecret) return null
  const id = headers.get('svix-id')
  const timestamp = headers.get('svix-timestamp')
  const signature = headers.get('svix-signature')
  if (!id || !timestamp || !signature) return null
  try {
    // Resend's verify() expects the normalized svix header trio (throws on invalid).
    const evt = client.webhooks.verify({ payload: rawBody, headers: { id, timestamp, signature }, webhookSecret }) as any
    if (!evt || typeof evt.type !== 'string') return null
    return {
      type: evt.type,
      messageId: evt?.data?.email_id ?? evt?.data?.id ?? null,
      createdAt: evt?.created_at ?? evt?.data?.created_at ?? null,
    }
  } catch {
    return null // any verification exception → invalid webhook
  }
}
