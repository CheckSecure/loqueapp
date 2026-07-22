/**
 * Match Profile Completion — how ready a member's profile is for HIGH-QUALITY
 * matching, based ONLY on the fields the recommendation engine actually uses.
 *
 * This is intentionally separate from generic "profile completion" (name, photo,
 * bio, …). A profile can be 85% "complete" generically yet score poorly in
 * matching because the matchable fields are thin — which is exactly what the batch
 * review revealed for the zero/one-introduction members. Surfacing this dedicated
 * score, plus the specific missing fields, tells a member precisely what to add to
 * get better introductions (and powers the empty/low-match experience).
 *
 * Pure + dependency-light so it is safe in both server and client bundles.
 */

export type MatchField = {
  key: 'intro_preferences' | 'purposes' | 'expertise' | 'interests'
  label: string        // short label for UI
  prompt: string       // the onboarding-style question that fills it
  done: boolean
}

export type MatchProfileCompletion = {
  percent: number          // 0–100
  complete: boolean        // percent === 100
  completedCount: number
  totalCount: number
  fields: MatchField[]     // all matchable fields, in priority order
  missing: MatchField[]    // the ones still empty (what to prompt)
}

/** The recommendation-engine fields, in the order they most improve match quality. */
const MATCH_FIELDS: Omit<MatchField, 'done'>[] = [
  { key: 'intro_preferences', label: 'Who you want to meet', prompt: 'Who would you like to meet?' },
  { key: 'purposes', label: 'Your goals', prompt: 'What are your goals on Andrel?' },
  { key: 'expertise', label: 'Areas of expertise', prompt: 'What areas of expertise do you have?' },
  { key: 'interests', label: 'Industries & interests', prompt: 'What industries and topics interest you?' },
]

/** Normalize the profile fields (array | JSON | pg-array | csv | single) to a list. */
function toList(value: unknown): string[] {
  if (value == null) return []
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean)
  if (typeof value !== 'string') return []
  let t = value.trim()
  if (!t || t === '{}' || t === '[]') return []
  if (t.startsWith('[') && t.endsWith(']')) { try { const j = JSON.parse(t); if (Array.isArray(j)) return j.map((x: any) => String(x).trim()).filter(Boolean) } catch { /* fall through */ } }
  if (t.startsWith('{') && t.endsWith('}')) t = t.slice(1, -1)
  return t.split(',').map(s => s.replace(/^"|"$/g, '').trim()).filter(Boolean)
}

export function matchProfileCompletion(profile: Record<string, unknown> | null | undefined): MatchProfileCompletion {
  const fields: MatchField[] = MATCH_FIELDS.map(f => ({ ...f, done: toList(profile?.[f.key]).length > 0 }))
  const completedCount = fields.filter(f => f.done).length
  const totalCount = fields.length
  const percent = Math.round((completedCount / totalCount) * 100)
  return { percent, complete: completedCount === totalCount, completedCount, totalCount, fields, missing: fields.filter(f => !f.done) }
}
