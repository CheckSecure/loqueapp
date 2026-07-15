/**
 * Single source of truth for profile-completion fields.
 *
 * Used by BOTH the ProfileCompletionCard (checklist + percent) and the
 * Introductions page (to decide whether to show the completion card or the
 * focused ProfilePhotoReminder). One definition so the two prompts can never
 * disagree about what "complete" means or double-nag about the photo.
 *
 * Independent of the matcher's network-value completeness (lib/scoring.ts) — a
 * user-facing checklist, not matching logic.
 */

export interface ProfileCompletionFields {
  photo: boolean
  company: boolean
  role: boolean
  expertise: boolean
  about: boolean
  linkedin: boolean
  location: boolean
}

/** Weighted checklist items (weights total 100). */
export const COMPLETION_ITEMS: { key: keyof ProfileCompletionFields; label: string; weight: number }[] = [
  { key: 'company', label: 'Company', weight: 15 },
  { key: 'role', label: 'Role', weight: 15 },
  { key: 'expertise', label: 'Expertise', weight: 15 },
  { key: 'photo', label: 'Profile photo', weight: 20 },
  { key: 'about', label: 'About', weight: 15 },
  { key: 'linkedin', label: 'LinkedIn', weight: 10 },
  { key: 'location', label: 'Location', weight: 10 },
]

/**
 * Normalize the many shapes `expertise` can take across legacy and current
 * rows into a clean string list. Supabase returns a jsonb/text[] column as a JS
 * array, but older rows (and text columns) come back as a JSON-encoded array
 * (`["AI","Privacy"]`), a Postgres array literal (`{AI,"Privacy Law"}`), or a
 * comma-separated string (`AI, Privacy`). Any of these with ≥1 value means the
 * member has expertise — checking `Array.isArray` alone silently failed for
 * every string-stored user (the profile-completion bug). Kept local so this
 * shared utility stays dependency-free for both client and server bundles.
 */
export function normalizeExpertiseList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim())
  }
  if (typeof value === 'string') {
    const t = value.trim()
    if (!t) return []
    // JSON-encoded array: ["AI","Privacy"]
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t)
        if (Array.isArray(parsed)) {
          return parsed.filter((x) => typeof x === 'string' && x.trim().length > 0).map((s: string) => s.trim())
        }
      } catch {
        /* malformed JSON — fall through to CSV handling */
      }
    }
    // Postgres array literal: {AI,"Privacy Law"}
    if (t.startsWith('{') && t.endsWith('}')) {
      return t.slice(1, -1).split(',').map((s) => s.replace(/^"|"$/g, '').trim()).filter(Boolean)
    }
    // Comma-separated string: "AI, Privacy" — also the recovery path for
    // malformed JSON/array literals, so strip any stray wrapping brackets or
    // quotes from each token before checking for real content.
    return t
      .split(',')
      .map((s) => s.replace(/^[[\]{}"'\s]+|[[\]{}"'\s]+$/g, ''))
      .filter(Boolean)
  }
  return []
}

/** Compute the presence booleans from a profile row (server-side). */
export function computeProfileCompletionFields(p: any): ProfileCompletionFields {
  return {
    photo: Boolean(p?.avatar_url),
    company: Boolean(p?.company?.trim?.()),
    role: Boolean(p?.role_type?.trim?.()),
    // Robust across array / JSON-string / CSV / PG-array / null shapes so
    // existing string-stored users are not falsely marked incomplete.
    expertise: normalizeExpertiseList(p?.expertise).length > 0,
    about: Boolean(p?.bio?.trim?.()),
    linkedin: Boolean(p?.linkedin_url?.trim?.()),
    location: Boolean(p?.location?.trim?.()),
  }
}

/** Weighted completion percentage (0–100). */
export function completionPercent(fields: ProfileCompletionFields): number {
  return COMPLETION_ITEMS.reduce((sum, item) => sum + (fields[item.key] ? item.weight : 0), 0)
}

/**
 * True iff the ONLY incomplete item is the photo — i.e. avatar is missing and
 * every other tracked field is complete. This is the exclusive trigger for the
 * ProfilePhotoReminder; when false, the ProfileCompletionCard owns the prompt.
 */
export function isOnlyPhotoMissing(fields: ProfileCompletionFields): boolean {
  if (fields.photo) return false
  return COMPLETION_ITEMS.every((item) => item.key === 'photo' || fields[item.key])
}
