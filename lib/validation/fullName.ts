// Shared full-name validation — the single authority for what a member's
// `full_name` may be, used by every path that can write it (onboarding, profile
// edit, waitlist signup, referral nomination, admin invite) and mirrored on the
// client. A valid name has at least two whitespace-separated tokens after
// normalization, so a single word ("Eller") can never enter the system.
//
// Normalization only trims and collapses internal whitespace — it never rewrites
// the name — so middle names, initials, suffixes, hyphenated names, and accented
// characters are all preserved verbatim:
//   "  Eric   Eller "   → "Eric Eller"
//   "Mary Ann Smith"    → "Mary Ann Smith"
//   "John A. Doe"       → "John A. Doe"
//   "Jane Smith Jr."    → "Jane Smith Jr."
//   "Anne-Marie O'Neil" → "Anne-Marie O'Neil"
//   "José  García"      → "José García"

export const FULL_NAME_ERROR = 'Please enter your first and last name.'

/** Trim and collapse internal whitespace. Does not alter characters otherwise. */
export function normalizeFullName(input: string | null | undefined): string {
  return String(input ?? '').replace(/\s+/g, ' ').trim()
}

/** Count of whitespace-separated tokens after normalization. */
function tokenCount(input: string | null | undefined): number {
  const n = normalizeFullName(input)
  return n.length === 0 ? 0 : n.split(' ').length
}

/** True when the value is a usable full name (>= 2 tokens). */
export function isValidFullName(input: string | null | undefined): boolean {
  return tokenCount(input) >= 2
}

/**
 * Validate a submitted full name. Returns the normalized value on success, or a
 * single friendly error on failure. Server-authoritative — every write path calls
 * this before persisting.
 */
export function validateFullName(
  input: string | null | undefined,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = normalizeFullName(input)
  if (tokenCount(value) < 2) return { ok: false, error: FULL_NAME_ERROR }
  return { ok: true, value }
}

/**
 * Anti-downgrade: decide the name to keep when a background writer (import,
 * enrichment, sync, provisioning) proposes a new value over an existing one.
 *
 * A valid existing name is NEVER replaced by an invalid (single-token/blank)
 * proposal. A valid proposal wins (an intentional rename). If neither is valid,
 * the existing value is kept untouched — names are never guessed or fabricated.
 */
export function resolveFullNameUpdate(
  existing: string | null | undefined,
  proposed: string | null | undefined,
): { value: string | null; changed: boolean } {
  const existingNorm = normalizeFullName(existing)
  const proposedNorm = normalizeFullName(proposed)

  if (isValidFullName(proposedNorm)) {
    // A valid proposal is accepted (and normalized); flag whether it differs.
    return { value: proposedNorm, changed: proposedNorm !== existingNorm }
  }
  // Proposal is invalid → keep the existing value exactly as it was (no downgrade,
  // no fabrication). Preserve null vs. one-token distinction of the original.
  return { value: existing ?? null, changed: false }
}

/**
 * Onboarding prefill authority. Priority:
 *   1. an existing valid profile name,
 *   2. a valid waitlist name (the name the member was invited under),
 *   3. blank.
 * Prefill only — never a write. This is what would have prevented Eric's issue:
 * with no valid profile name, onboarding pre-fills the waitlist's "Eric Eller".
 */
export function pickOnboardingPrefillName(
  profileName: string | null | undefined,
  waitlistName: string | null | undefined,
): string {
  const p = normalizeFullName(profileName)
  if (isValidFullName(p)) return p
  const w = normalizeFullName(waitlistName)
  if (isValidFullName(w)) return w
  return p // preserve any partial profile entry; '' when nothing known
}
