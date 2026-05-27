// Shared match-signal logic used by the profile detail page ("Why Andrel
// introduced you") and the introductions cards ("Why this introduction").
// Keeping a single implementation prevents the two surfaces from drifting.

// Normalizes the varied shapes interests/purposes/expertise can take (native
// array, JSON-string array, or comma-separated string) into a clean string list.
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

function eqField(a: any, b: any): boolean {
  return Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase())
}

// Overlap of two list-valued fields, returning the viewed-side casing, capped.
function overlap(viewerVal: any, viewedVal: any, max: number): string[] {
  const viewerSet = new Set(toList(viewerVal).map(s => s.toLowerCase()))
  return toList(viewedVal).filter(x => viewerSet.has(x.toLowerCase())).slice(0, max)
}

// Computes true shared signals between the viewer and a viewed/suggested
// profile. Returns only signals that genuinely apply (no invented reasons),
// capped at 5. Order is by priority so the most professionally meaningful
// signals lead: professional alignment, then relationship intent, then
// personal interest last (a consumer slicing to N keeps the strongest).
export function computeMatchSignals(viewer: any, viewed: any): string[] {
  const signals: string[] = []
  if (!viewer || !viewed) return signals

  // --- Priority 1: professional alignment ---
  if (eqField(viewed.role_type, viewer.role_type)) signals.push('Same role type')
  if (eqField(viewed.seniority, viewer.seniority)) signals.push('Similar seniority')
  if (eqField(viewed.location, viewer.location)) signals.push('Same location')
  const sharedExpertise = overlap(viewer.expertise, viewed.expertise, 3)
  if (sharedExpertise.length > 0) signals.push(`Shared expertise: ${sharedExpertise.join(', ')}`)

  // --- Priority 2: relationship intent ---
  const vmr = String(viewer.mentorship_role || '').toLowerCase()
  const pmr = String(viewed.mentorship_role || '').toLowerCase()
  const complementary =
    (['mentor', 'both'].includes(vmr) && ['mentee', 'both'].includes(pmr)) ||
    (['mentee', 'both'].includes(vmr) && ['mentor', 'both'].includes(pmr))
  if (complementary) signals.push('Mentorship match')
  else if (vmr && pmr) signals.push('Both open to mentorship')
  const sharedPurposes = overlap(viewer.purposes, viewed.purposes, 2)
  if (sharedPurposes.length > 0) signals.push(`Shared focus: ${sharedPurposes.join(', ')}`)

  // --- Priority 3: personal interest (last) ---
  const sharedInterests = overlap(viewer.interests, viewed.interests, 3)
  if (sharedInterests.length > 0) signals.push(`Shared interests: ${sharedInterests.join(', ')}`)

  return signals.slice(0, 5)
}
