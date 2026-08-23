/**
 * Canonical site origin for building AUTH REDIRECT links (password recovery, etc.).
 *
 * Production MUST resolve to https://www.andrel.app. This is derived ONLY from the
 * NEXT_PUBLIC_SITE_URL env var, with a hard-coded canonical fallback — it is NEVER
 * derived from window.location.origin, so a recovery link can never accidentally point
 * at localhost, a Vercel preview URL, or a www/non-www variant the browser happened to
 * be on. Set NEXT_PUBLIC_SITE_URL=https://www.andrel.app in production (and to your local
 * origin in dev). This module does not read or change any Supabase dashboard config.
 *
 * DEPLOYMENT NOTE: NEXT_PUBLIC_SITE_URL must be set to https://www.andrel.app. The env var WINS
 * over the fallback, so leaving it on the apex would silently keep the old origin in production.
 */
export function getSiteUrl(): string {
  const raw = (process.env.NEXT_PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '')
  return raw || CANONICAL_SITE_URL // canonical production fallback — never window.origin
}

/**
 * THE canonical production origin. www, not apex.
 *
 * Both spellings were in use: this helper fell back to the apex while the invite-reminder email
 * hardcoded https://www.andrel.app. Two spellings of one origin is how a link ends up on a host the
 * cookie or the redirect was not written for, and a fragment-carried token is exactly the payload
 * you least want travelling through an unplanned redirect. There is now one spelling, here.
 *
 * NEVER hardcode an origin anywhere else — import getSiteUrl() instead.
 */
export const CANONICAL_SITE_URL = 'https://www.andrel.app'

/** The resume landing page, absolute. e.g. https://www.andrel.app/resume */
export function getResumeUrl(): string {
  return `${getSiteUrl()}/resume`
}

/** The scanner-hardened recovery landing page, absolute. e.g. https://www.andrel.app/auth/recover */
export function getRecoveryRedirectUrl(): string {
  return `${getSiteUrl()}/auth/recover`
}
