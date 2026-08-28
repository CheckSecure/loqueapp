import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * ONE-CLICK UNSUBSCRIBE (RFC 8058) — token, headers, and footer.
 *
 * Modeled directly on lib/referrals/manageToken.ts: a stateless HMAC over the payload, so the link
 * needs no DB row, no new column, and no expiry bookkeeping. Deterministic — the same (email,
 * category) always yields the same token — because an unsubscribe link must keep working for as
 * long as the email exists in someone's mailbox. A token IDENTIFIES A MAILBOX FOR ONE PURPOSE; it
 * authenticates nobody and grants no session. The worst a leaked token can do is stop mail the
 * holder was already receiving.
 *
 * Why this is not just a link to /dashboard/settings (what the referral email does today): that
 * page is session-gated, so it is unactionable for the invite recipients whose gateways are
 * flagging us — they have no account. A gateway probing it gets a login redirect, not an
 * unsubscribe.
 */

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://www.andrel.app').replace(/\/+$/, '')

/** Where an unsubscribe request lands. Must be POST-able without a session. */
export const UNSUBSCRIBE_PATH = '/api/email/unsubscribe'

/** The mailbox a human reply-to-unsubscribe reaches. */
export const UNSUBSCRIBE_MAILTO = 'hello@andrel.app'

function secret(): string {
  return process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url')
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url')
}

/** Addresses are compared and stored lowercased everywhere; do it once, here. */
export function normalizeEmail(email: string): string {
  return (email || '').trim().toLowerCase()
}

/**
 * Build the opaque token for an address + mail category.
 * The category is carried in the token so a one-click unsubscribe stops the list that actually
 * sent the message, rather than silently opting the recipient out of everything.
 */
export function makeUnsubscribeToken(email: string, category: string): string {
  const p = b64url(`${normalizeEmail(email)}|${category}`)
  return `${p}.${sign(p)}`
}

export interface UnsubscribeClaim {
  email: string
  category: string
}

/** Verify a token and return its claim, or null if missing/tampered/malformed. */
export function verifyUnsubscribeToken(token: string | null | undefined): UnsubscribeClaim | null {
  const t = (token || '').trim()
  const dot = t.indexOf('.')
  if (dot <= 0) return null
  const p = t.slice(0, dot)
  const sig = t.slice(dot + 1)
  // Constant-time compare on equal-length buffers.
  const a = Buffer.from(sig)
  const b = Buffer.from(sign(p))
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let decoded: string
  try {
    decoded = Buffer.from(p, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const bar = decoded.indexOf('|')
  if (bar <= 0) return null
  const email = decoded.slice(0, bar)
  const category = decoded.slice(bar + 1)
  if (!email || !category) return null
  return { email, category }
}

export function unsubscribeUrl(token: string): string {
  return `${SITE_URL}${UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}`
}

/**
 * The two headers gateways actually score.
 *
 * List-Unsubscribe-Post is what makes the https URL a ONE-CLICK unsubscribe: the receiving provider
 * POSTs the fixed body itself, without a human ever opening the link. It is only honored alongside
 * an https URI in List-Unsubscribe, which is why both are emitted together and never separately.
 *
 * The mailto is kept as the fallback for gateways that do not implement 8058.
 */
export function unsubscribeHeaders(email: string, category: string): Record<string, string> {
  const url = unsubscribeUrl(makeUnsubscribeToken(email, category))
  return {
    'List-Unsubscribe': `<mailto:${UNSUBSCRIBE_MAILTO}?subject=unsubscribe>, <${url}>`,
    'List-Unsubscribe-Post': 'List=One-Click',
  }
}

/**
 * The visible footer. A header alone is not enough — gateways and recipients both look for a link
 * in the body, and a message whose only unsubscribe is a header still reads as bulk mail.
 *
 * Appended as a sibling block after the message body, so no existing template needs restructuring.
 */
export function unsubscribeFooterHtml(email: string, category: string): string {
  const url = unsubscribeUrl(makeUnsubscribeToken(email, category))
  return `
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 24px auto 0; padding-top: 16px; border-top: 1px solid #e2e8f0;">
        <p style="color: #94a3b8; font-size: 12px; line-height: 1.5; margin: 0;">
          You received this because you're part of the Andrel network.
          <a href="${url}" style="color: #94a3b8; text-decoration: underline;">Unsubscribe</a>
          &middot;
          <a href="${SITE_URL}/dashboard/settings" style="color: #94a3b8; text-decoration: underline;">Manage email preferences</a>
        </p>
      </div>`
}

/**
 * Plain-text counterpart. Messages that ship a text/plain alternative must carry the link there
 * too — a recipient reading the text part would otherwise see no way to unsubscribe, and some
 * filters compare the two parts.
 */
export function unsubscribeFooterText(email: string, category: string): string {
  const url = unsubscribeUrl(makeUnsubscribeToken(email, category))
  return `\n\n—\nYou received this because you're part of the Andrel network.\nUnsubscribe: ${url}\nManage email preferences: ${SITE_URL}/dashboard/settings\n`
}
