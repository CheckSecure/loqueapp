/**
 * lib/auth/recovery.ts — scanner-resistant password-recovery logic.
 *
 * WHY: enterprise email security (Microsoft Safe Links, Mimecast, Proofpoint) PREFETCHES
 * links in email. A directly-consumable one-time verify link is burned by that prefetch
 * before the user ever clicks — exactly what locked Matt Boucher out. The fix is an
 * intermediate page whose initial GET verifies NOTHING; only a deliberate button click
 * verifies the token. A scanner's GET then renders a static page and cannot consume the
 * token.
 *
 * This module holds the framework-agnostic pieces so they can be unit-tested in a node
 * environment (the app has no DOM test runner). `RecoveryFlow.init()` performs NO token
 * verification — proving prefetch-safety — while `RecoveryFlow.confirm()` (the click)
 * performs the single verification.
 *
 * Security invariants enforced here:
 *  - token verification never happens on init/GET, only on explicit confirm;
 *  - redirect targets are validated to internal paths only (no open redirect);
 *  - the token is never logged, embedded in a redirect, or returned to callers.
 */

export const ALLOWED_OTP_TYPES = ['recovery', 'magiclink', 'email', 'invite', 'signup'] as const
export type OtpType = (typeof ALLOWED_OTP_TYPES)[number]

export function isValidOtpType(type: string | null | undefined): type is OtpType {
  return !!type && (ALLOWED_OTP_TYPES as readonly string[]).includes(type)
}

/**
 * Reduce a caller-supplied `next` to a SAFE internal path, else fall back. Blocks open
 * redirects: anything not starting with a single '/', protocol-relative '//', backslashes,
 * embedded schemes, or characters outside a strict allowlist is rejected.
 */
export function sanitizeRedirect(next: string | null | undefined, fallback = '/auth/reset-password'): string {
  if (!next || typeof next !== 'string') return fallback
  if (!next.startsWith('/')) return fallback          // must be an absolute internal path
  if (next.startsWith('//')) return fallback          // protocol-relative → external
  if (next.includes('\\')) return fallback            // backslash tricks
  if (/:/.test(next.split('?')[0])) return fallback   // no scheme/colon in the path
  if (!/^\/[A-Za-z0-9/_\-?=&.%]*$/.test(next)) return fallback
  return next
}

export type VerifyErrorKind = 'expired' | 'used' | 'invalid' | 'other'

/** Map a Supabase verifyOtp error message to a user-facing category. Takes only the
 *  message string — never the token — so it can't leak a secret. */
export function classifyVerifyError(message: string | undefined | null): VerifyErrorKind {
  const m = (message ?? '').toLowerCase()
  if (m.includes('expired')) return 'expired'
  if (m.includes('already') || m.includes('used') || m.includes('consumed')) return 'used'
  if (m.includes('invalid') || m.includes('not found')) return 'invalid'
  return 'other'
}

export const RECOVERY_MESSAGES: Record<VerifyErrorKind, string> = {
  expired: 'This reset link has expired. Links are single-use and expire after one hour — please request a new one.',
  used: 'This reset link has already been used. Please request a new one.',
  invalid: 'This reset link is invalid. Please request a new one.',
  other: 'We couldn’t verify this reset link. Please request a new one.',
}

export interface RecoveryParams {
  token_hash?: string | null
  type?: string | null
  next?: string | null
}

/**
 * Read recovery params from the URL, preferring the FRAGMENT (#…) over the query string.
 * The recommended email template puts the token in the fragment, which browsers never send
 * to the server — so the token_hash does not appear in Vercel/CDN/proxy/middleware request
 * logs at all. The query string is read only as a resilience fallback (e.g. an email client
 * that strips fragments); if a query-based link is ever used, the token WOULD reach the
 * request URL — a documented tradeoff of that configuration.
 */
export function parseRecoveryParamsFromLocation(
  hash: string | null | undefined,
  search: string | null | undefined,
): RecoveryParams {
  const h = new URLSearchParams((hash ?? '').replace(/^#/, ''))
  const q = new URLSearchParams(search ?? '')
  const pick = (k: string) => h.get(k) ?? q.get(k)
  return { token_hash: pick('token_hash'), type: pick('type'), next: pick('next') }
}

// Minimal shape of the verifyOtp-capable client (keeps this module free of the SDK type).
export interface VerifyCapableClient {
  auth: { verifyOtp(args: { token_hash: string; type: any }): Promise<{ error: { message?: string } | null }> }
}

export type ConfirmResult =
  | { ok: true; redirect: string }
  | { ok: false; kind: VerifyErrorKind; message: string }

/**
 * The recovery state machine used by the intermediate page.
 *   init()    — validate params ONLY. Performs no verification (prefetch-safe by construction).
 *   confirm() — the deliberate user action. Performs the single token verification.
 */
export class RecoveryFlow {
  constructor(private client: VerifyCapableClient, private params: RecoveryParams) {}

  /** Validate presence/shape of params. NEVER verifies the token. */
  init(): { state: 'ready' } | { state: 'invalid'; reason: 'missing_token' | 'invalid_type' } {
    if (!this.params.token_hash) return { state: 'invalid', reason: 'missing_token' }
    if (!isValidOtpType(this.params.type)) return { state: 'invalid', reason: 'invalid_type' }
    return { state: 'ready' }
  }

  /** The explicit "Continue password reset" action — the only place the token is consumed. */
  async confirm(): Promise<ConfirmResult> {
    const gate = this.init()
    if (gate.state !== 'ready') {
      return { ok: false, kind: 'invalid', message: RECOVERY_MESSAGES.invalid }
    }
    const { error } = await this.client.auth.verifyOtp({
      token_hash: this.params.token_hash!,
      type: this.params.type as OtpType,
    })
    if (error) {
      const kind = classifyVerifyError(error.message)
      return { ok: false, kind, message: RECOVERY_MESSAGES[kind] }
    }
    return { ok: true, redirect: sanitizeRedirect(this.params.next) }
  }
}
