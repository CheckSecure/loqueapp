// Matching V2 — desired-connections rank-only boost.
//
// Applies AFTER the >=10 eligibility gate, on the candidate's rankingScore
// (computed by applyTierRankingAdjustment). Never touches finalScore, never
// promotes a sub-threshold candidate into the batch — pure re-ranker.
//
// Flag gate: process.env.MATCHING_V2_VERTICAL_BOOST === '1'. When off, every
// public export short-circuits to a no-op so the call-sites are byte-identical
// to current behavior.

import { titleToCategory } from '@/lib/role-taxonomy'

/**
 * Magnitude of the desired-connections boost for one (viewer, candidate) pair.
 *
 *   15  — candidate's role_type is in viewer's desired title list for that category
 *    8  — whole-category match (viewer's desired[category] === [])
 *    0  — otherwise, including:
 *           · no preference set / candidate has no role_type
 *           · candidate's category isn't in viewer's preferences
 *           · category is selected with specific titles and candidate isn't one
 *           · candidate's role_type maps to 'Other' / unknown taxonomy
 *
 * Intra-vertical asks ARE supported: e.g. a GC who selects {Legal:['CLO']}
 * gets a +15 boost on Chief Legal Officer candidates. The empty-preference
 * guard above is what keeps existing users (all of whom default to {})
 * byte-identical to current behavior.
 *
 * Caller is responsible for the env-flag gate.
 */
export function verticalBoostFor(viewer: any, candidate: any): number {
  if (!viewer || !candidate) return 0

  const desired = viewer.desired_connections
  if (!desired || typeof desired !== 'object' || Array.isArray(desired)) return 0
  if (Object.keys(desired).length === 0) return 0

  const candidateRoleType = candidate.role_type
  if (typeof candidateRoleType !== 'string' || !candidateRoleType) return 0

  const candidateCategory = titleToCategory(candidateRoleType)
  if (!candidateCategory || candidateCategory === 'Other') return 0

  if (!(candidateCategory in desired)) return 0
  const titles = desired[candidateCategory]
  if (!Array.isArray(titles)) return 0

  if (titles.includes(candidateRoleType)) return 15
  if (titles.length === 0) return 8
  return 0
}

/**
 * Human-readable match-signals reason. Returns null when no boost fires, so the
 * caller can simply skip when null. Uses the same gating logic as
 * verticalBoostFor — they cannot disagree on whether a boost applies.
 */
export function verticalBoostReason(viewer: any, candidate: any): string | null {
  if (!viewer || !candidate) return null
  const desired = viewer.desired_connections
  if (!desired || typeof desired !== 'object' || Array.isArray(desired)) return null
  if (Object.keys(desired).length === 0) return null

  const candidateRoleType = candidate.role_type
  if (typeof candidateRoleType !== 'string' || !candidateRoleType) return null

  const candidateCategory = titleToCategory(candidateRoleType)
  if (!candidateCategory || candidateCategory === 'Other') return null

  if (!(candidateCategory in desired)) return null
  const titles = desired[candidateCategory]
  if (!Array.isArray(titles)) return null

  if (titles.includes(candidateRoleType)) {
    return `You asked to meet ${titlePhrase(candidateRoleType)}`
  }
  if (titles.length === 0) {
    return `You asked to meet ${candidateCategory} leaders`
  }
  return null
}

// Avoid awkward plurals like "VP Marketings" or "Head of FP&As" — short, clean
// titles get a simple "+s"; the rest are passed through singular.
function titlePhrase(title: string): string {
  if (title.endsWith('s')) return title
  if (/(&|^VP\b|^Head of\b)/.test(title)) return title
  return `${title}s`
}

/**
 * Rank-only boost applied to an already-eligible candidate set. Bumps each
 * matched candidate's rankingScore by verticalBoostFor's magnitude, then
 * re-sorts.
 *
 * Byte-identical to input when:
 *   · MATCHING_V2_VERTICAL_BOOST !== '1'  (flag off)
 *   · viewer has no desired_connections     (no preference)
 *   · no candidate matches                  (nothing to boost)
 */
export function applyVerticalBoost(candidates: any[], viewer: any): any[] {
  if (process.env.MATCHING_V2_VERTICAL_BOOST !== '1') return candidates

  const desired = viewer?.desired_connections
  if (
    !desired ||
    typeof desired !== 'object' ||
    Array.isArray(desired) ||
    Object.keys(desired).length === 0
  ) {
    return candidates
  }

  let anyBoosted = false
  const boosted = candidates.map((c) => {
    const b = verticalBoostFor(viewer, c)
    if (b > 0) {
      anyBoosted = true
      return { ...c, rankingScore: c.rankingScore + b }
    }
    return c
  })
  if (!anyBoosted) return candidates
  return boosted.sort((a, b) => b.rankingScore - a.rankingScore)
}
