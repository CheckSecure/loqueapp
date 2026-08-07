/**
 * Canonical site origin for building AUTH REDIRECT links (password recovery, etc.).
 *
 * Production MUST resolve to https://andrel.app. This is derived ONLY from the
 * NEXT_PUBLIC_SITE_URL env var, with a hard-coded canonical fallback — it is NEVER
 * derived from window.location.origin, so a recovery link can never accidentally point
 * at localhost, a Vercel preview URL, or a www/non-www variant the browser happened to
 * be on. Set NEXT_PUBLIC_SITE_URL=https://andrel.app in production (and to your local
 * origin in dev). This module does not read or change any Supabase dashboard config.
 */
export function getSiteUrl(): string {
  const raw = (process.env.NEXT_PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '')
  return raw || 'https://andrel.app' // canonical production fallback — never window.origin
}

/** The scanner-hardened recovery landing page, absolute. e.g. https://andrel.app/auth/recover */
export function getRecoveryRedirectUrl(): string {
  return `${getSiteUrl()}/auth/recover`
}
