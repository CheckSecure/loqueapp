import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Invitation resume tokens.
 *
 * A resume token AUTHENTICATES NOBODY. It is a revocable reference to an invitation, and presenting
 * it does exactly one thing: asks the server to send a fresh secure sign-in email, through the
 * existing hardened ceremony, to the address ALREADY on that invitation. A forwarded token cannot
 * let the holder in — at most it causes an email to arrive in the rightful owner's inbox. That is
 * the property, not an expiry, that makes a long-lived token acceptable.
 *
 * ONLY THE SHA-256 IS PERSISTED. The plaintext exists exactly twice: in this process for the
 * moment it takes to build the email, and in the recipient's inbox. It is never stored, never
 * logged, never returned to a browser, never placed in a query string and never in a metric.
 *
 * SHA-256 WITHOUT A SALT IS CORRECT HERE, which is worth stating because it is wrong almost
 * everywhere else. A password hash must be slow and salted because passwords are low-entropy and
 * guessable. This token is 32 bytes from the CSPRNG — 256 bits. There is no dictionary to run and
 * no rainbow table to build, so a fast digest is exactly right, and a salt would only prevent the
 * indexed lookup the design depends on.
 */

/** 32 bytes = 256 bits. */
export const RESUME_TOKEN_BYTES = 32

export interface MintedResumeToken {
  /** base64url plaintext. Goes to the email sender and NOWHERE else. Never persist this. */
  token: string
  /** SHA-256 digest — the only value that may touch the database. */
  tokenSha256: Buffer
}

export function mintResumeToken(): MintedResumeToken {
  const raw = randomBytes(RESUME_TOKEN_BYTES)
  const token = raw.toString('base64url')
  return { token, tokenSha256: sha256(token) }
}

export function sha256(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

/**
 * Accept a token from the wire. Rejects anything that is not a plausible base64url encoding of
 * exactly 32 bytes BEFORE hashing, so malformed input never reaches the database.
 */
export function parseResumeToken(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const t = input.trim()
  if (t.length < 42 || t.length > 44) return null   // 32 bytes base64url = 43 chars (± padding)
  if (!/^[A-Za-z0-9_-]+$/.test(t)) return null
  try {
    if (Buffer.from(t, 'base64url').length !== RESUME_TOKEN_BYTES) return null
  } catch { return null }
  return t
}

/** Constant-time digest comparison, for any path that compares two hashes in application code. */
export function digestsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The reminder URL. The token rides in the FRAGMENT.
 *
 * A fragment is never sent to a server, so the token appears in no access log, no CDN log, no
 * middleware log and no Referer header. It is also why the page must scrub it from history the
 * moment it is captured. A query parameter would have leaked it into all of the above — this is the
 * same reasoning that already governs /auth/recover.
 *
 * The origin comes from getSiteUrl(); no origin is spelled out here.
 */
export function buildResumeLink(siteUrl: string, token: string): string {
  const base = siteUrl.replace(/\/+$/, '')
  return `${base}/resume#token=${encodeURIComponent(token)}`
}

/**
 * Coarse outcomes of the atomic server-side claim. The database distinguishes these so an operator
 * can diagnose; the HTTP layer must NOT — every non-'ok' value maps to one identical response, or
 * the endpoint becomes an account-existence oracle.
 */
export type ResumeClaimStatus =
  | 'ok' | 'invalid' | 'revoked' | 'completed' | 'ambiguous' | 'suppressed' | 'rate_limited'

// The generic response text lives in resumeMessages.ts, which has NO Node imports, so the client
// resume page can use it without pulling node:crypto into the browser bundle.
export { RESUME_GENERIC_RESPONSE } from './resumeMessages'
