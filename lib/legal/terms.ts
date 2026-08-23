/**
 * Single source of truth for the Terms of Service and Privacy Policy versions +
 * effective dates. Every legal surface (the /terms and /privacy pages, the
 * onboarding clickwrap, acceptance records, and the re-acceptance check) reads
 * these constants — nothing hardcodes a version string or date anywhere else.
 *
 * To publish a revision:
 *   1. edit the document page (app/terms/page.tsx or app/privacy/page.tsx)
 *   2. bump the integer *_VERSION (and *_VERSION_LABEL / *_EFFECTIVE_DATE)
 * For TERMS that single bump also forces existing users to re-accept.
 * For PRIVACY it does NOT: publishing and requiring are separate decisions, held
 * apart by MIN_REQUIRED_PRIVACY_VERSION. Bumping PRIVACY_VERSION updates the
 * display and what an acceptance records; raising the minimum is what routes
 * existing members through the gate. Neither needs a migration or a backfill.
 *
 * Versions are monotonic integers so comparison (accepted < current) is always
 * correct; the *_LABEL strings are display-only ("Version 1.0").
 */

// ── Terms of Service ──────────────────────────────────────────────────────────
export const TERMS_VERSION = 1
export const TERMS_VERSION_LABEL = '1.0'
export const TERMS_EFFECTIVE_DATE = 'July 27, 2026'

// ── Privacy Policy ────────────────────────────────────────────────────────────
// v2 (August 22, 2026): §5 Data Retention now discloses the limited deletion audit record retained
// for up to seven years after an account is removed. TERMS_VERSION is deliberately untouched — the
// Terms of Service did not change.
//
// PUBLISHED version. This is what the page displays and what an acceptance RECORDS. It is never the
// version used to decide access — see MIN_REQUIRED_PRIVACY_VERSION below.
export const PRIVACY_VERSION = 2
export const PRIVACY_VERSION_LABEL = '2.0'
export const PRIVACY_EFFECTIVE_DATE = 'August 22, 2026'

/**
 * The MINIMUM privacy version that satisfies the access gate — deliberately separate from the
 * published version above.
 *
 * WHY THESE ARE TWO NUMBERS. Publishing a revision and forcing every existing member through
 * /legal/accept are different decisions, and collapsing them into one integer means you cannot make
 * the first without also making the second. v2 discloses a retention practice; it does not change
 * what members agreed to in a way that warrants interrupting everyone mid-session on deploy.
 *
 * CURRENT EFFECT (published 2, minimum 1):
 *   • no recorded acceptance at all  → gated, and accepting records the PUBLISHED version (2)
 *   • accepted privacy v1            → satisfied, continues to the dashboard uninterrupted
 *   • accepted privacy v2            → satisfied
 *   • grandfathered through v1       → satisfied
 *
 * TO REQUIRE v2 LATER: change this ONE constant to 2. Every member on v1 is then routed through
 * /legal/accept on their next request. No migration, no backfill, no bulk update, no database
 * rewrite — and nothing about members' stored acceptance records changes, because the decision is
 * made by comparing them, not by editing them.
 *
 * INVARIANT: this must never exceed PRIVACY_VERSION, or every member would be gated by a version
 * that cannot be accepted. Asserted below.
 */
export const MIN_REQUIRED_PRIVACY_VERSION = 1

// Guards the invariant at module load rather than leaving it to a comment. A raised minimum with no
// published version to satisfy it would lock every member out of the product.
if (MIN_REQUIRED_PRIVACY_VERSION > PRIVACY_VERSION) {
  throw new Error('MIN_REQUIRED_PRIVACY_VERSION cannot exceed PRIVACY_VERSION')
}

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
  /**
   * The minimum privacy version that satisfies the gate. Defaults to the current published version,
   * so an existing three-argument call keeps exactly the meaning it had: minimum == published.
   */
  minPrivacyVersion: number = currentPrivacyVersion,
): boolean {
  const acceptedTerms = state.acceptedTermsVersion ?? 0
  const acceptedPrivacy = state.acceptedPrivacyVersion ?? 0
  const grandfatheredTerms = state.grandfatheredTermsVersion ?? 0
  const grandfatheredPrivacy = state.grandfatheredPrivacyVersion ?? 0

  // Terms behaviour is UNCHANGED: always compared against the current published Terms version.
  const termsSatisfied =
    acceptedTerms >= currentTermsVersion || grandfatheredTerms >= currentTermsVersion

  // Privacy is compared against the MINIMUM REQUIRED version, not the published one. The decision is
  // made from the member's own durable acceptance record — never from an account creation date,
  // which is a proxy that goes wrong the moment a record and a timestamp disagree.
  //
  // A member with no record at all scores 0, which is below any minimum of 1 or more, so "never
  // accepted" is still gated. Raising the minimum later re-gates the members below it and nobody
  // else.
  const privacySatisfied =
    acceptedPrivacy >= minPrivacyVersion || grandfatheredPrivacy >= minPrivacyVersion

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
  return needsReacceptanceAt(TERMS_VERSION, PRIVACY_VERSION, state, MIN_REQUIRED_PRIVACY_VERSION)
}
