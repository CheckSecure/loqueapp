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
    // PostgreSQL array literal: {item1,"item 2"}
    if (t.startsWith('{') && t.endsWith('}')) {
      return t.slice(1, -1).split(',').map(s => s.replace(/^"|"$/g, '').trim()).filter(Boolean)
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

// ── "Why you were introduced" reason builder ───────────────────────────────
//
// Deterministic, gender-neutral, prioritized prose reasons shown as the intro
// headline. Built from the SAME primitives as computeMatchSignals so the two
// surfaces never disagree. Guarantees:
//   · NO pronoun/gender inference — names, "you", and "they" only.
//   · NO Math.random — pure function of its inputs; same pair → same reasons.
//   · NO company dependency — a missing company never forces a fallback.
//   · Specific reasons rank above generic ones; seniority is supporting only
//     and can never be the sole reason when a stronger signal exists (it is
//     always built last).
// Returns 0–3 concise reason strings; callers add the fallback when empty.

/** Restrained, truthful fallback when no meaningful signal applies. */
export const GENERIC_INTRO_FALLBACK =
  'This introduction was selected based on your connection preferences and network goals.'

export interface IntroReasonOptions {
  /** Max reasons returned (default 3). */
  max?: number
  /** Symmetric, name-free phrasing for the admin two-row case where a single
   *  stored string is shown to BOTH members. Drops direction-specific reasons. */
  mutual?: boolean
}

function firstName(p: any): string {
  const n = String(p?.full_name || '').trim().split(/\s+/)[0]
  return n || 'They'
}

function purposesInclude(p: any, needles: string[]): boolean {
  const set = new Set(toList(p?.purposes).map((s) => s.toLowerCase()))
  return needles.some((n) => set.has(n.toLowerCase()))
}

function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] || ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

export function buildIntroReasons(
  viewer: any,
  candidate: any,
  opts: IntroReasonOptions = {},
): string[] {
  const max = opts.max ?? 3
  const mutual = opts.mutual ?? false
  const out: string[] = []
  if (!viewer || !candidate) return out

  const name = firstName(candidate)
  const push = (s: string | null | undefined) => {
    const t = (s || '').trim()
    if (t && !out.includes(t)) out.push(t)
  }

  const sharedExpertise = overlap(viewer.expertise, candidate.expertise, 3)
  const viewerExp = new Set(toList(viewer.expertise).map((s) => s.toLowerCase()))
  const uniqueCandidateExp = toList(candidate.expertise)
    .filter((e) => !viewerExp.has(e.toLowerCase()))
    .slice(0, 2)
  const sharedPurposes = overlap(viewer.purposes, candidate.purposes, 2)

  let roleCovered = false

  // (a) Desired connection — viewer explicitly asked to meet this kind of
  //     person. Direction-specific, so skipped in mutual mode.
  if (!mutual) {
    const desired = verticalBoostReason(viewer, candidate)
    if (desired) {
      push(desired)
      roleCovered = true
    }
  }

  // (a) Shared stated purpose / goal.
  if (sharedPurposes.length > 0) push(`You're both focused on ${sharedPurposes[0]}`)

  // (b) Business value — hiring / open-to-roles / business development.
  const viewerHiring = purposesInclude(viewer, ['Hiring', 'Recruiting'])
  const candidateHiring = purposesInclude(candidate, ['Hiring', 'Recruiting'])
  const viewerSellsBD = purposesInclude(viewer, ['Business Development'])
  const candidateSellsBD = purposesInclude(candidate, ['Business Development'])
  if (mutual) {
    if ((viewerHiring && candidate.open_to_roles === true) || (candidateHiring && viewer.open_to_roles === true))
      push('One of you is hiring; the other is open to new roles')
    if ((viewerSellsBD && candidate.open_to_business_solutions === true) || (candidateSellsBD && viewer.open_to_business_solutions === true))
      push('One of you offers business solutions the other is open to')
  } else {
    if (viewerHiring && candidate.open_to_roles === true) push(`${name} is open to new roles`)
    else if (viewer.open_to_roles === true && candidateHiring) push(`${name} is hiring`)
    if (viewer.open_to_business_solutions === true && candidateSellsBD) push(`${name} works in business development`)
    else if (viewerSellsBD && candidate.open_to_business_solutions === true) push(`${name} is open to new business solutions`)
  }

  // (b) Complementary expertise — only when nothing is shared, so it never
  //     overlaps the shared-expertise bullet. Direction-specific.
  if (!mutual && sharedExpertise.length === 0 && uniqueCandidateExp.length > 0)
    push(`${name} brings expertise in ${listPhrase(uniqueCandidateExp)}`)

  // (c) Meaningful shared expertise.
  if (sharedExpertise.length > 0) push(`You share expertise in ${listPhrase(sharedExpertise)}`)

  // (d) Role / industry alignment.
  if (!roleCovered && candidate.role_type && candidate.role_type !== 'Other' && eqField(candidate.role_type, viewer.role_type))
    push(`You both work as ${candidate.role_type}`)
  if (eqField(candidate.industry, viewer.industry)) push(`You both work in ${candidate.industry}`)

  // (e) Mentorship alignment.
  const vmr = String(viewer.mentorship_role || '').toLowerCase()
  const cmr = String(candidate.mentorship_role || '').toLowerCase()
  const complementary =
    (['mentor', 'both'].includes(vmr) && ['mentee', 'both'].includes(cmr)) ||
    (['mentee', 'both'].includes(vmr) && ['mentor', 'both'].includes(cmr))
  if (complementary) push('Mentorship fit — one of you is open to mentoring, the other to being mentored')
  else if ((viewer.open_to_mentorship === true && candidate.open_to_mentorship === true) || (vmr && cmr))
    push("You're both open to mentorship")

  // (f) Geographic overlap.
  if (eqField(candidate.location, viewer.location) || eqField(candidate.city, viewer.city))
    push(`You're both based in ${candidate.location || candidate.city}`)

  // (g) Seniority — supporting only. Built last, so it is never the sole reason
  //     when any stronger signal above applies.
  if (eqField(candidate.seniority, viewer.seniority)) push("You're at a similar career stage")

  return out.slice(0, max)
}

/**
 * Storage form of the reasons: newline-joined bullets, or the restrained
 * fallback when no meaningful signal exists. The Introductions page renders a
 * multi-line value as a bullet list and a single line as prose.
 */
export function introReasonText(viewer: any, candidate: any, opts?: IntroReasonOptions): string {
  const reasons = buildIntroReasons(viewer, candidate, opts)
  return reasons.length > 0 ? reasons.join('\n') : GENERIC_INTRO_FALLBACK
}
