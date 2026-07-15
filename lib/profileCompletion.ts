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

/** Compute the presence booleans from a profile row (server-side). */
export function computeProfileCompletionFields(p: any): ProfileCompletionFields {
  return {
    photo: Boolean(p?.avatar_url),
    company: Boolean(p?.company?.trim?.()),
    role: Boolean(p?.role_type?.trim?.()),
    expertise: Array.isArray(p?.expertise) && p.expertise.length > 0,
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
