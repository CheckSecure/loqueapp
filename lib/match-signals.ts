// Shared match-signal logic used by the profile detail page ("Why Andrel
// introduced you") and the introductions cards ("Why this introduction").
// Keeping a single implementation prevents the two surfaces from drifting.

// Normalizes the varied shapes interests/purposes can take (native array,
// JSON-string array, or comma-separated string) into a clean string list.
export function toList(value: any): string[] {
  if (Array.isArray(value)) {
    return value.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
  }
  if (typeof value === 'string') {
    const t = value.trim()
    if (!t) return []
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t)
        if (Array.isArray(parsed)) return parsed.filter((x: any) => typeof x === 'string' && x.trim().length > 0)
      } catch {}
    }
    return t.split(',').map(s => s.trim()).filter(Boolean)
  }
  return []
}

// Computes true shared signals between the viewer and a viewed/suggested
// profile. Returns only signals that genuinely apply (no invented reasons),
// capped at 5. Order is intentional: role, interests, seniority, mentorship,
// location.
export function computeMatchSignals(viewer: any, viewed: any): string[] {
  const signals: string[] = []
  if (!viewer || !viewed) return signals

  if (
    viewed.role_type && viewer.role_type &&
    String(viewed.role_type).toLowerCase() === String(viewer.role_type).toLowerCase()
  ) {
    signals.push('Same role type')
  }

  const viewerInterests = toList(viewer.interests).map(s => s.toLowerCase())
  const sharedInterests = toList(viewed.interests)
    .filter(i => viewerInterests.includes(i.toLowerCase()))
    .slice(0, 3)
  if (sharedInterests.length > 0) signals.push(`Shared interests: ${sharedInterests.join(', ')}`)

  if (
    viewed.seniority && viewer.seniority &&
    String(viewed.seniority).toLowerCase() === String(viewer.seniority).toLowerCase()
  ) {
    signals.push('Similar seniority')
  }

  const vmr = String(viewer.mentorship_role || '').toLowerCase()
  const pmr = String(viewed.mentorship_role || '').toLowerCase()
  if ((vmr === 'mentor' && pmr === 'mentee') || (vmr === 'mentee' && pmr === 'mentor')) {
    signals.push('Mentorship match')
  }

  if (
    viewed.location && viewer.location &&
    String(viewed.location).toLowerCase() === String(viewer.location).toLowerCase()
  ) {
    signals.push('Same location')
  }

  return signals.slice(0, 5)
}
