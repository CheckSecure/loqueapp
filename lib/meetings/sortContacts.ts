/**
 * Alphabetize the meeting-request recipient dropdown.
 *
 * Sort A→Z by display name, case-insensitively; when two display names are equal
 * (case-insensitively), break the tie by email so ordering is stable and
 * deterministic. Returns a NEW array — never mutates the input — so callers can
 * sort right before rendering without side effects.
 */
export interface SortableContact {
  full_name?: string | null
  email?: string | null
}

export function sortContactsByName<T extends SortableContact>(contacts: T[]): T[] {
  return [...contacts].sort((a, b) => {
    const an = (a.full_name || '').trim()
    const bn = (b.full_name || '').trim()
    const byName = an.localeCompare(bn, undefined, { sensitivity: 'base' })
    if (byName !== 0) return byName
    // Secondary key: email, also case-insensitive.
    const ae = (a.email || '').trim()
    const be = (b.email || '').trim()
    return ae.localeCompare(be, undefined, { sensitivity: 'base' })
  })
}
