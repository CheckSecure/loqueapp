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
 * A member's legal-standing inputs. Two independent ways a document can be
 * satisfied:
 *   • accepted*Version    — they affirmatively clicked-through this version.
 *   • grandfathered*Version — they existed before grandfathering and are EXEMPTED
 *     from the gate through this version (an access exemption, NOT acceptance).
 * All fields are nullable; a null means "no signal" (treated as version 0).
 */
export interface LegalAcceptanceState {
  acceptedTermsVersion?: number | null
  acceptedPrivacyVersion?: number | null
  grandfatheredTermsVersion?: number | null
  grandfatheredPrivacyVersion?: number | null
}

/**
 * Version-parameterized core: does the member still owe acceptance, given the
 * supplied CURRENT versions? A document is satisfied when the accepted version OR
 * the grandfathered-through version is at least the current version. Pure and
 * null-safe. Exposed separately so tests can simulate a future version bump
 * without mutating the shipped constants.
 */
export function needsReacceptanceAt(
  currentTermsVersion: number,
  currentPrivacyVersion: number,
  state: LegalAcceptanceState,
): boolean {
  const acceptedTerms = state.acceptedTermsVersion ?? 0
  const acceptedPrivacy = state.acceptedPrivacyVersion ?? 0
  const grandfatheredTerms = state.grandfatheredTermsVersion ?? 0
  const grandfatheredPrivacy = state.grandfatheredPrivacyVersion ?? 0

  const termsSatisfied =
    acceptedTerms >= currentTermsVersion || grandfatheredTerms >= currentTermsVersion
  const privacySatisfied =
    acceptedPrivacy >= currentPrivacyVersion || grandfatheredPrivacy >= currentPrivacyVersion

  return !termsSatisfied || !privacySatisfied
}

/**
 * True when the member must (re)accept the CURRENT Terms and/or Privacy versions
 * before continuing. Satisfied by affirmative acceptance OR a grandfathering
 * exemption through the current version. Grandfathering is only an access
 * exemption — it never counts as affirmative acceptance and never populates the
 * accepted-version fields. Pure — safe on client and server.
 */
export function needsReacceptance(state: LegalAcceptanceState): boolean {
  return needsReacceptanceAt(TERMS_VERSION, PRIVACY_VERSION, state)
}
