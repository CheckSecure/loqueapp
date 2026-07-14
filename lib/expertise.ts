/**
 * Unified expertise helpers for the profile/onboarding expertise selector.
 *
 * There is ONE expertise system now: every stored value loads into the same
 * selected-chip list and is removable. These helpers back that UI.
 *
 * Read-only: neither function mutates storage. The stored format (a flat
 * string[] / comma-joined text column) and API contract are unchanged.
 */
import { parseExpertise } from '@/lib/parseExpertise'
import { EXPERTISE_OPTIONS } from '@/lib/profile-options'

/**
 * Normalize a stored expertise value into a clean string[] for the selector.
 *
 * - Parses every legacy storage format via parseExpertise (array / JSON / PG
 *   literal / CSV / single / null).
 * - Maps case/whitespace variants of a canonical option to its canonical
 *   spelling (e.g. "  networking " → "Networking"), preserving clean display
 *   capitalization.
 * - De-duplicates case-insensitively; the first occurrence wins.
 * - Preserves values that are not (yet) canonical, trimmed, so previously saved
 *   expertise always loads as a manageable selected chip.
 */
export function normalizeExpertise(
  raw: unknown,
  options: readonly string[] = EXPERTISE_OPTIONS,
): string[] {
  const canonicalByKey = new Map<string, string>()
  for (const opt of options) canonicalByKey.set(opt.trim().toLowerCase(), opt)

  const out: string[] = []
  const seen = new Set<string>()
  for (const value of parseExpertise(raw)) {
    const trimmed = value.trim()
    if (!trimmed) continue
    const display = canonicalByKey.get(trimmed.toLowerCase()) ?? trimmed
    const dedupeKey = display.toLowerCase()
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    out.push(display)
  }
  return out
}

/**
 * Options to show in the "Add expertise" dropdown: canonical options that match
 * the query, EXCLUDING already-selected values (case-insensitive) so a selected
 * item never appears as a duplicate selectable result.
 */
export function filterExpertiseOptions(
  query: string,
  selected: string[],
  options: readonly string[] = EXPERTISE_OPTIONS,
): string[] {
  const q = query.trim().toLowerCase()
  const selectedKeys = new Set(selected.map((s) => s.trim().toLowerCase()))
  return options.filter((opt) => {
    if (selectedKeys.has(opt.toLowerCase())) return false
    if (q && !opt.toLowerCase().includes(q)) return false
    return true
  })
}
