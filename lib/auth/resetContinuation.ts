import { createHmac, timingSafeEqual } from 'crypto'

// Server-issued continuation token proving "THIS user completed a password update on the server."
// It is the ONLY trustworthy evidence that authorizes a password-free finalization retry (clearing
// password_reset_required). It is:
//   - tamper-resistant  — HMAC-SHA256 over `<uid>.<exp>` with a server-only secret;
//   - user-bound        — the uid is inside the signed payload and re-checked against the session;
//   - short-lived       — expires (default 10 min);
//   - server-only       — carried in an HttpOnly cookie the browser JS cannot read or forge.
// A client-set value can never satisfy verifyContinuationToken (no secret → no valid signature).

export const CONTINUATION_COOKIE = 'andrel_reset_cont'
export const CONTINUATION_TTL_MS = 10 * 60 * 1000

function signingKey(): string | null {
  // A dedicated secret if provided, else the always-present server-only service-role key. Never
  // exposed to the client. If absent, no token can be issued/verified → finalize-retry is disabled
  // (fail closed); the initial update+clear still happens in one server execution.
  return process.env.RESET_CONTINUATION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || null
}

function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url')
}

/** Issue a token for `userId` valid until now+TTL. Returns null if no signing key is configured. */
export function issueContinuationToken(userId: string, nowMs: number): string | null {
  const key = signingKey()
  if (!key || !userId) return null
  const exp = nowMs + CONTINUATION_TTL_MS
  const payload = `${userId}.${exp}`
  return `${payload}.${sign(payload, key)}`
}

/** True only for a well-formed, unexpired token whose signature verifies AND whose uid === userId. */
export function verifyContinuationToken(token: string | null | undefined, userId: string, nowMs: number): boolean {
  const key = signingKey()
  if (!key || !token || !userId) return false
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const [uid, expStr, sig] = parts
  const expected = sign(`${uid}.${expStr}`, key)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false // constant-time
  if (uid !== userId) return false                                   // bound to the session user
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || nowMs > exp) return false             // expired / malformed
  return true
}
