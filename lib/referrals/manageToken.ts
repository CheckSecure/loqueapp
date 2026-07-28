import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Stateless, tamper-proof token for the nominee "Manage your information" link.
 *
 * The token encodes the waitlist row id plus an HMAC signature, so the manage page
 * can identify the nominee WITHOUT a new DB column and without a forgeable raw id
 * in the URL. Deterministic (same id → same token) so the link embedded in the
 * email stays valid. The signing key is a server-only secret (never shipped to the
 * client): a dedicated MANAGE_INFO_SECRET if set, else the service-role key.
 *
 * Security note: this identifies-only. Deletion is still a POST (never a GET), so a
 * corporate email scanner that auto-fetches the link can never delete anything.
 */
function secret(): string {
  return process.env.MANAGE_INFO_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url')
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url')
}

/** Build the opaque token for a waitlist id. */
export function makeManageToken(waitlistId: string): string {
  const p = b64url(waitlistId)
  return `${p}.${sign(p)}`
}

/** Verify a token and return the waitlist id, or null if missing/tampered. */
export function verifyManageToken(token: string | null | undefined): string | null {
  const t = (token || '').trim()
  const dot = t.indexOf('.')
  if (dot <= 0) return null
  const p = t.slice(0, dot)
  const sig = t.slice(dot + 1)
  const expected = sign(p)
  // Constant-time compare on equal-length buffers.
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    return Buffer.from(p, 'base64url').toString('utf8') || null
  } catch {
    return null
  }
}
