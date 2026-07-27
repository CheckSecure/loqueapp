/**
 * Single source of truth for the Terms of Service and Privacy Policy versions +
 * effective dates. Every legal surface (the /terms and /privacy pages, the
 * onboarding clickwrap, acceptance records, and the re-acceptance check) reads
 * these constants — nothing hardcodes a version string or date anywhere else.
 *
 * To publish a revision:
 *   1. edit the document page (app/terms/page.tsx or app/privacy/page.tsx)
 *   2. bump the integer *_VERSION (and *_VERSION_LABEL / *_EFFECTIVE_DATE)
 * That single bump makes the version display update AND forces existing users to
 * re-accept via needsReacceptance() — no other change or migration required.
 *
 * Versions are monotonic integers so comparison (accepted < current) is always
 * correct; the *_LABEL strings are display-only ("Version 1.0").
 */

// ── Terms of Service ──────────────────────────────────────────────────────────
export const TERMS_VERSION = 1
export const TERMS_VERSION_LABEL = '1.0'
export const TERMS_EFFECTIVE_DATE = 'July 27, 2026'

// ── Privacy Policy ────────────────────────────────────────────────────────────
export const PRIVACY_VERSION = 1
export const PRIVACY_VERSION_LABEL = '1.0'
export const PRIVACY_EFFECTIVE_DATE = 'March 24, 2026'

/**
 * True when the user has already accepted the current Terms AND Privacy versions.
 * A null/undefined (never accepted) or lower accepted version means they must
 * (re)accept before continuing. Pure — safe to use on client and server.
 */
export function needsReacceptance(
  acceptedTermsVersion: number | null | undefined,
  acceptedPrivacyVersion: number | null | undefined,
): boolean {
  return (acceptedTermsVersion ?? 0) < TERMS_VERSION || (acceptedPrivacyVersion ?? 0) < PRIVACY_VERSION
}
