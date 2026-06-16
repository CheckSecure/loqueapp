// Shared match-signal logic used by the profile detail page ("Why Andrel
// introduced you") and the introductions cards ("Why this introduction").
// Keeping a single implementation prevents the two surfaces from drifting.

import { verticalBoostReason } from '@/lib/matching/vertical-boost'

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

export interface MatchSignals {
  // Ordered signal strings (professional → intent → interest), capped at 5.
  signals: string[]
  // True if any professional (P1) or relationship-intent (P2) signal applies.
  // When false but signals is non-empty, the only overlap is personal interest.
  hasStrongSignals: boolean
  // Raw overlapping interests, for rendering the weak-only supporting line.
  sharedInterests: string[]
}

// Computes true shared signals between the viewer and a viewed/suggested
// profile. Returns only signals that genuinely apply (no invented reasons),
// capped at 5. Order is by priority so the most professionally meaningful
// signals lead: professional alignment, then relationship intent, then
// personal interest last. `hasStrongSignals` lets callers detect the
// interest-only case and avoid letting "Shared interests" read as the headline.
export function computeMatchSignals(viewer: any, viewed: any): MatchSignals {
  const signals: string[] = []
  let hasStrongSignals = false
  const pushStrong = (s: string) => { signals.push(s); hasStrongSignals = true }

  if (!viewer || !viewed) return { signals, hasStrongSignals, sharedInterests: [] }

  // --- Priority 0 (Matching V2): explicit desired-connections ask ---
  // Only fires when MATCHING_V2_VERTICAL_BOOST is on AND the (viewer, viewed)
  // pair would receive a real boost in the scoring path. Stays in lockstep with
  // applyVerticalBoost so the reason can never appear without the boost.
  if (process.env.MATCHING_V2_VERTICAL_BOOST === '1') {
    const askReason = verticalBoostReason(viewer, viewed)
    if (askReason) pushStrong(askReason)
  }

  // --- Priority 1: professional alignment ---
  if (eqField(viewed.role_type, viewer.role_type)) pushStrong('Same role type')
  if (eqField(viewed.seniority, viewer.seniority)) pushStrong('Similar seniority')
  if (eqField(viewed.location, viewer.location)) pushStrong('Same location')
  const sharedExpertise = overlap(viewer.expertise, viewed.expertise, 3)
  if (sharedExpertise.length > 0) pushStrong(`Shared expertise: ${sharedExpertise.join(', ')}`)

  // --- Priority 2: relationship intent ---
  const vmr = String(viewer.mentorship_role || '').toLowerCase()
  const pmr = String(viewed.mentorship_role || '').toLowerCase()
  const complementary =
    (['mentor', 'both'].includes(vmr) && ['mentee', 'both'].includes(pmr)) ||
    (['mentee', 'both'].includes(vmr) && ['mentor', 'both'].includes(pmr))
  if (complementary) pushStrong('Mentorship match')
  else if (vmr && pmr) pushStrong('Both open to mentorship')
  const sharedPurposes = overlap(viewer.purposes, viewed.purposes, 2)
  if (sharedPurposes.length > 0) pushStrong(`Shared focus: ${sharedPurposes.join(', ')}`)

  // --- Priority 3: personal interest (last) ---
  const sharedInterests = overlap(viewer.interests, viewed.interests, 3)
  if (sharedInterests.length > 0) signals.push(`Shared interests: ${sharedInterests.join(', ')}`)

  return { signals: signals.slice(0, 5), hasStrongSignals, sharedInterests }
}
