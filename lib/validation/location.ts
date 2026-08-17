// Shared physical-location validation — the single authority for what a member's
// `profiles.location` may be, used by every path that can write it (top-level
// onboarding, dashboard onboarding, profile edit, the profile-completion gate)
// and mirrored on the client for UX.
//
// WHY: three completed profiles reached profile_complete=true with no usable
// location (two NULL, one "Remote"). "Remote" describes a work arrangement, not
// a place, so it can never satisfy the requirement.
//
// CONTRACT
//   - A member may be mid-draft with NO location; the value is required only at
//     the boundary where profile_complete becomes true, and to keep an already
//     complete profile complete.
//   - Normalization ONLY trims and collapses internal whitespace. Capitalization,
//     punctuation, accents and script are preserved verbatim. Nothing is geocoded,
//     transliterated, expanded or rewritten: "Boston" stays "Boston", never
//     "Boston, MA"; "München" is never folded to "Munchen".
//   - No comma, no US state, no country and no ASCII requirement, so every one of
//     these is valid:
//       "New York, NY"  "Boston"  "Asheville, NC"  "London, UK"  "Singapore"
//       "São Paulo, Brazil"  "Kraków"  "München"  "東京"  "北京"  "دبي"  "ירושלים"
//   - Rejection is limited to values that are blank, placeholder-ONLY, longer than
//     LOCATION_MAX_LENGTH, or that carry fewer than two letters ("-", "...", "123").
//
// This is a FORMAT check only. Nothing here verifies that the place exists or
// that the member is there — no copy may claim the location was verified.
//
// ── TWO TIERS, AND WHY ───────────────────────────────────────────────────────
// This module is the FINE-GRAINED authority and runs on every write path.
// Migration 061 adds a deliberately COARSER database floor:
//
//              | non-blank | <= 120 chars | placeholder list | >= 2 letters
//   TypeScript |     x     |      x       |        x         |      x
//   CHECK (061)|     x     |      x       |        x         |      -
//
// The letter test is TypeScript-only ON PURPOSE. Expressing "is a letter" in SQL
// needs [[:alpha:]] / [[:punct:]], whose behaviour depends on the database's
// lc_ctype, so the same "東京" could pass in one locale and fail in another. A
// constraint that rejects a row this validator accepted would break a legitimate
// member's save, so the shared floor keeps only rules that are byte-for-byte
// deterministic in both engines. The floor is never STRICTER than TypeScript —
// that is the invariant the parity tests pin down.
//
// The three rules that ARE shared are engine-identical by construction:
//   non-blank      trim on both sides; any value with >= 2 letters is non-blank
//   length <= 120  Postgres length() counts characters, JS .length counts UTF-16
//                  code units, so JS can only ever count MORE (astral chars) —
//                  never fewer. TypeScript is therefore the stricter side.
//   placeholder    identical key derivation, see `placeholderKey` below.

export const LOCATION_ERROR = 'Enter the city and state, region, or country where you are based.'

/** Generous cap for "San Francisco Bay Area, California, United States" and the like. */
export const LOCATION_MAX_LENGTH = 120
export const LOCATION_TOO_LONG_ERROR = `Please shorten your location to ${LOCATION_MAX_LENGTH} characters or fewer.`

/** Shown under the field. States what is wanted without promising verification. */
export const LOCATION_HELP_TEXT = 'City and state, region, or country. A work arrangement such as “Remote” is not a location.'

/**
 * Placeholder answers that describe a work arrangement, a refusal, or nothing at
 * all. Compared on `placeholderKey` (see below), so "N/A", "n / a" and "na" all
 * collapse to the same entry.
 *
 * Deliberately matched ONLY against the WHOLE value. A substring rule would
 * reject real places ("Virtual" is a placeholder; "Virginia Beach, VA" is not),
 * and anything containing a real place alongside a word like "Remote" is left to
 * a human rather than guessed at here.
 *
 * EXPORTED because migration 061 embeds this same list as a SQL array; the parity
 * test compares the two literally, so the sets can never drift apart.
 */
export const PLACEHOLDER_LOCATION_KEYS: readonly string[] = [
  // Explicitly required by the location policy
  'remote',
  'remoteonly',
  'anywhere',
  'virtual',
  'na',              // covers "n/a" and "na"
  'none',
  'notapplicable',
  'prefernottosay',
  'tbd',
  // Same class of answer, same reasoning
  'remotefirst',
  'fullyremote',
  'workfromhome',
  'wfh',
  'hybrid',
  'distributed',
  'digitalnomad',
  'nomad',
  'online',
  'internet',
  'global',
  'worldwide',
  'everywhere',
  'nowhere',
  'earth',
  'unknown',
  'undisclosed',
  'tba',
  'prefernottoanswer',
  'declinetostate',
]

const PLACEHOLDER_LOCATION_KEY_SET = new Set(PLACEHOLDER_LOCATION_KEYS)

/**
 * Trim and collapse internal whitespace. Nothing else is altered — case,
 * punctuation, accents and non-Latin scripts survive exactly as entered.
 *   "  New York ,  NY " → "New York , NY"
 *   "london, uk"        → "london, uk"   (never title-cased)
 */
export function normalizeLocation(input: string | null | undefined): string {
  return String(input ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Placeholder-lookup key. The order of operations is part of the cross-engine
 * contract and must not be swapped:
 *
 *   1. strip every character outside [A-Za-z0-9]   (ASCII-only, deterministic)
 *   2. lowercase the surviving ASCII               (locale-independent by then)
 *
 * PostgreSQL performs exactly these two steps, in this order, in migration 061.
 * Lowercasing FIRST would diverge: JS lowercases "İ" (U+0130) to "i" + combining
 * dot, whose "i" would survive the ASCII strip, while Postgres strips U+0130
 * outright — so "İnternet" would key as "internet" here but "nternet" there.
 *
 * Non-Latin scripts key to the empty string ("東京" → "", "دبي" → "") in BOTH
 * engines, and the empty string is never a placeholder, so they are always kept.
 */
function placeholderKey(input: string | null | undefined): string {
  return normalizeLocation(input).replace(/[^A-Za-z0-9]/g, '').toLowerCase()
}

/**
 * Count of characters that are neither whitespace, digits, nor ASCII punctuation —
 * i.e. "how many letters is this, roughly". Everything outside that subtractive set
 * counts, so every script is preserved: "東京" → 2, "北京" → 2, "دبي" → 3,
 * "ירושלים" → 7, "München" → 7, "Kraków" → 6.
 *
 * Subtractive (strip non-letters) rather than additive (match \p{L}) so it needs no
 * Unicode property escapes, which require a newer compile target than this project
 * uses. TypeScript-only: see the two-tier note in the header for why this rule is
 * deliberately absent from the database constraint.
 */
function letterCount(input: string | null | undefined): number {
  const stripped = normalizeLocation(input)
    .replace(/[\s\d]/g, '')
    .replace(/[-–—_,.;:!?'"`^~*+=/\\|<>(){}\[\]@#$%&]/g, '')
  return stripped.length
}

/** True when the whole value is a placeholder rather than a place. */
export function isPlaceholderLocation(input: string | null | undefined): boolean {
  const key = placeholderKey(input)
  return key.length > 0 && PLACEHOLDER_LOCATION_KEY_SET.has(key)
}

/** True when the value is usable as a member's physical location. */
export function isValidLocation(input: string | null | undefined): boolean {
  return validateLocation(input).ok
}

/**
 * Validate a submitted location. Returns the NORMALIZED value on success (trim +
 * whitespace collapse only) or a single member-facing error. Server-authoritative:
 * every path that can set profile_complete=true calls this before persisting.
 */
export function validateLocation(
  input: string | null | undefined,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = normalizeLocation(input)
  if (value.length === 0) return { ok: false, error: LOCATION_ERROR }
  if (value.length > LOCATION_MAX_LENGTH) return { ok: false, error: LOCATION_TOO_LONG_ERROR }
  if (letterCount(value) < 2) return { ok: false, error: LOCATION_ERROR }
  if (isPlaceholderLocation(value)) return { ok: false, error: LOCATION_ERROR }
  return { ok: true, value }
}

/**
 * Decide what a profile-EDIT save may do to `location`.
 *
 *   proposed valid                        → write the normalized value
 *   proposed blank, profile NOT complete  → allow null (a draft may omit it)
 *   proposed blank, profile IS complete   → reject; a complete profile's valid
 *                                           location can never be cleared
 *   proposed non-blank but invalid        → reject, always. Writing "Remote" over
 *                                           a real place is never an improvement,
 *                                           complete or not.
 *
 * Never rewrites or geocodes, and never invents a value for a member who left the
 * field alone — callers only reach this when the field was actually submitted.
 */
export function resolveLocationUpdate(
  proposed: string | null | undefined,
  opts: { profileComplete: boolean },
): { ok: true; value: string | null } | { ok: false; error: string } {
  const value = normalizeLocation(proposed)
  if (value.length === 0) {
    if (opts.profileComplete) return { ok: false, error: LOCATION_ERROR }
    return { ok: true, value: null }
  }
  const check = validateLocation(value)
  if (!check.ok) return { ok: false, error: check.error }
  return { ok: true, value: check.value }
}
