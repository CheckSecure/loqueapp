// Current focus areas (Phase B) — the shared normalizer + fail-open persistence
// for `profiles.current_focus_areas`.
//
// A member's current focus areas are the topics/technologies/industries/policy
// areas especially relevant to them right now (e.g. "Nuclear energy", "Energy
// policy"). Optional, editable, and a SOFT matching signal only — never part of
// profile completion, onboarding, or eligibility.
//
// Storage authority: always a normalized `string[]`. Reads accept any legacy shape
// (array | JSON string | CSV | empty) so the field is robust to format drift, the
// same way expertise/interests are.

import { isMissingColumnError } from '@/lib/db/isMissingColumn'

/** Max number of focus areas a member may store. */
export const MAX_FOCUS_AREAS = 10
/** Defensive per-value length bound (the input also enforces this). */
export const MAX_FOCUS_AREA_LEN = 60

/** Suggested starter tags shown in the UI (examples, not a closed taxonomy). */
export const SUGGESTED_FOCUS_AREAS: readonly string[] = [
  'Nuclear energy',
  'Energy policy',
  'Advanced manufacturing',
  'Deep tech investing',
  'AI regulation',
  'Private credit',
  'Cybersecurity policy',
  'Healthcare innovation',
]

/** Split any accepted input shape into raw tokens (before trim/dedupe/cap). */
function toRawTokens(input: unknown): string[] {
  if (input == null) return []
  if (Array.isArray(input)) return input.map((v) => String(v))
  if (typeof input !== 'string') return []
  let t = input.trim()
  if (!t || t === '[]' || t === '{}') return []
  if (t.startsWith('[') && t.endsWith(']')) {
    try {
      const j = JSON.parse(t)
      if (Array.isArray(j)) return j.map((v) => String(v))
    } catch {
      /* fall through to CSV */
    }
  }
  if (t.startsWith('{') && t.endsWith('}')) t = t.slice(1, -1) // pg-array literal
  return t.split(',').map((s) => s.replace(/^"|"$/g, ''))
}

/**
 * Normalize focus-area input to the canonical stored form:
 *  - accepts array | JSON string | CSV | empty
 *  - trims + collapses internal whitespace
 *  - drops blank entries
 *  - truncates any over-long value to MAX_FOCUS_AREA_LEN (defensive bound)
 *  - de-duplicates case-INSENSITIVELY, preserving the first-seen display casing
 *  - caps the list at MAX_FOCUS_AREAS
 * Never rewrites a legitimate term's spelling/casing.
 */
export function normalizeFocusAreas(input: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of toRawTokens(input)) {
    let v = String(raw).replace(/\s+/g, ' ').trim()
    if (!v) continue
    if (v.length > MAX_FOCUS_AREA_LEN) v = v.slice(0, MAX_FOCUS_AREA_LEN).trim()
    const key = v.toLowerCase()
    if (seen.has(key)) continue // case-insensitive dedupe, keep first casing
    seen.add(key)
    out.push(v)
    if (out.length >= MAX_FOCUS_AREAS) break
  }
  return out
}

/**
 * Persist a member's focus areas as a normalized array — WRITES ONLY this one
 * column, and FAILS OPEN if migration 041 hasn't been applied (missing column →
 * no-op, `persisted:false`), so profile saves never break pre-migration.
 *
 * Call only when the field was actually submitted (present-only), so an omitted
 * field never clears an existing value.
 */
export async function persistFocusAreas(
  db: { from: (t: string) => any },
  userId: string,
  rawInput: unknown,
): Promise<{ persisted: boolean; value: string[] }> {
  const value = normalizeFocusAreas(rawInput)
  const { error } = await db.from('profiles').update({ current_focus_areas: value }).eq('id', userId)
  if (error) {
    if (isMissingColumnError(error)) return { persisted: false, value } // migration 041 pending
    console.error('[focusAreas] persist failed:', (error as any)?.message)
    return { persisted: false, value }
  }
  return { persisted: true, value }
}
