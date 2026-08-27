/**
 * lib/matching/business-solutions.ts
 *
 * Shared helpers for classifying and throttling business-solution providers
 * (law firms, consultants, etc.) in both the live recommendation path and
 * the admin batch generation path.
 *
 * SEMANTIC MODEL (v3.2) — the throttle governs ONE relationship only:
 *
 *   • BUYER ↔ PROVIDER  (a non-provider member shown a provider): THROTTLED.
 *     `maxBusinessSolutionCount` is the buyer's quota — how many providers that
 *     member may be shown. Its sole purpose is to keep a member from feeling
 *     overwhelmed by vendors, and it respects the member's opt-in preference.
 *
 *   • PROVIDER ↔ PROVIDER (two providers meeting): PEER NETWORKING — EXEMPT.
 *     Two law firms / two consultants / an eDiscovery vendor meeting a forensics
 *     vendor is peers building their network, not vendor exposure. These edges are
 *     scored and optimized normally by the reciprocal graph and never count against
 *     any quota. The peer exemption lives at the edge level in the callers
 *     (selectReciprocalGraph / applyThrottling), because whether an edge is "peer"
 *     depends on BOTH endpoints — a fact this per-member quota can't see on its own.
 *
 * This replaced the pre-v3.2 behavior where, at the launch cap of 2, the quota
 * floored to 0 for everyone (percentage `floor(2 × 0.30) = 0` and the "guarantee 1"
 * clause was gated at `targetCount >= 3`). Combined with reciprocity — where a quota
 * of 0 blocks an edge from existing at all, not just from one member's list — that
 * made every provider mathematically unmatchable. Both problems are fixed here and
 * in the callers.
 */

/**
 * EXTERNAL service-provider role_type values that are matched EXACTLY, not by substring.
 *
 * Substring matching is how 'Executive Recruiter' would otherwise be classified by accident: it
 * contains none of the existing fragments today, but a future value like 'Recruiting Consultant'
 * would silently be swept in by `includes('consultant')`. An exact set says precisely which values
 * are providers and cannot drift.
 *
 * 'Executive Recruiter' IS here: an external search consultant sells a service to companies, so a
 * member being shown one is vendor exposure and belongs under the buyer/provider throttle.
 * 'In-House Talent Leader' is deliberately NOT here: they are an employee of a member company, a
 * peer, and a buyer of search services themselves.
 */
export const EXPLICIT_PROVIDER_ROLE_TYPES: readonly string[] = ['Executive Recruiter']

export function isBusinessSolutionProvider(candidate: { role_type?: string }): boolean {
  const raw = (candidate.role_type || '').trim()
  // Exact-match layer first — additive, and it can never widen the substring rules below.
  if (EXPLICIT_PROVIDER_ROLE_TYPES.includes(raw)) return true
  const roleType = raw.toLowerCase()
  return (
    roleType.includes('law firm') ||
    roleType.includes('consultant') ||
    roleType.includes('legal services') ||
    roleType.includes('legal tech')
  )
}

/**
 * A LEGAL PROFESSIONAL — a practicing lawyer or in-house/GC counsel. An introduction
 * between two legal professionals (e.g. a law-firm partner and a General Counsel) is
 * PEER professional networking — referrals, co-counsel, career moves — NOT vendor
 * exposure, so it must be exempt from the business-solution buyer/provider throttle
 * even when neither has opted into business solutions.
 *
 * Matches law-firm roles and in-house/GC/attorney/counsel roles. Deliberately does NOT
 * match 'legal services' / 'legal tech': those are legal VENDORS (SaaS/eDiscovery),
 * already covered by the provider↔provider peer rule, not peer lawyers — so a law
 * firm ↔ legal-tech vendor keeps its existing treatment, and a law firm ↔ software
 * vendor / consultant / non-legal buyer stays throttled exactly as before.
 */
export function isLegalProfessional(candidate: { role_type?: string }): boolean {
  const r = (candidate.role_type || '').toLowerCase()
  return r.includes('law firm') || r.includes('attorney') || r.includes('counsel') || r.includes('lawyer')
}

/**
 * True when BOTH members are legal professionals — a legal peer-networking edge that is
 * EXEMPT from the business-solution throttle (mirrors the provider↔provider peer
 * exemption, scoped to the legal domain). Used as the edge-level `isThrottleExemptPair`
 * by the batch selection path. Never broadens the exemption beyond legal↔legal.
 */
export function isLegalNetworkingPair(
  a: { role_type?: string },
  b: { role_type?: string },
): boolean {
  return isLegalProfessional(a) && isLegalProfessional(b)
}

const BASE_CAP = 0.30
const TIER_MULTIPLIERS: Record<string, number> = {
  free: 1.0,
  professional: 0.7,
  executive: 0.5,
  founding: 0.7,
}
const PREFERENCE_ADJUSTMENT = 0.5

/**
 * A BUYER's provider quota — the maximum number of business-solution providers a
 * NON-provider member may be shown in a batch of `targetCount`. (Provider↔provider
 * peer edges are exempt and are handled by the callers, not here — see the module
 * header.)
 *
 * Rules:
 *  • Opted-in members are ALWAYS eligible for at least one provider, at any cap —
 *    including the launch cap of 2, where the raw percentage `floor(2 × 0.30)` is 0.
 *    This replaces the old `targetCount >= 3` guarantee, which silently switched off
 *    once the launch cap dropped to 2 and made every provider unmatchable.
 *  • Members who have NOT opted in keep the reduced allowance (0 at small caps): they
 *    are shielded from provider recommendations unless they ask for them.
 *
 * Mirrors the throttle logic in applyThrottling() in generate-recommendations.ts.
 * Both paths must stay in sync — change this file, not the callers.
 */
/**
 * THROTTLE KILL SWITCH — off by default, because the quota is miscalibrated for the
 * launch-phase batch size. Set BUSINESS_SOLUTION_THROTTLE=on to restore the original
 * behaviour; any other value (including unset) floors the quota at `targetCount`.
 *
 * WHY IT IS OFF. The quota is a PERCENTAGE of the batch size, calibrated when batches were
 * 5-8 introductions (floor(8 * 0.30) = 2 providers for a buyer). BATCH_CONFIG now caps
 * everyone at 2 introductions, and at targetCount = 2 the arithmetic collapses:
 *
 *     raw = floor(2 * 0.30 * mult) = floor(0.60 / 0.42 / 0.30) = 0   for EVERY tier
 *     opted in     -> max(1, 0)      = 1
 *     NOT opted in -> floor(0 * 0.5) = 0
 *
 * MEASURED on production, 2026-08-27: 112 of 116 eligible members held a provider quota of
 * ZERO, so none of them could be introduced to any of the 23 members classified as providers
 * (role_type containing 'law firm', 'consultant', 'legal services', 'legal tech', or the exact
 * value 'Executive Recruiter'). providerCapOf is a HARD constraint in the optimizer, not a
 * ranking preference, so those edges could never be seated however good the score. Batch 5
 * left ~90 members below 2, dominated by members with FULL capacity and 80-115 nominally
 * eligible partners receiving ZERO — the signature of a hard constraint, not thin supply.
 *
 * That is an arithmetic accident between two independently-reasonable settings, not a product
 * rule anyone chose. The intent — limiting vendor exposure for members who did not ask for it
 * — is still worth having; it needs recalibrating for small batches, not deleting.
 *
 * REINSTATING IT PROPERLY. Do not simply flip this to 'on' once batches grow: at targetCount 3
 * the same floor still yields 0 for non-opted-in members (floor(0.9) = 0). Either express the
 * quota as an absolute number rather than a percentage, or make the percentage round UP for
 * members who have not opted in. Then set BUSINESS_SOLUTION_THROTTLE=on and re-measure with
 * the section-A/B queries in supabase/audits (composition + per-member pool collapse).
 *
 * NOT CHANGED HERE: MIN_RELEVANCE_SCORE. The score floor is a separate hypothesis and is being
 * measured on its own.
 */
export const BUSINESS_SOLUTION_THROTTLE_ENABLED =
  (process.env.BUSINESS_SOLUTION_THROTTLE ?? '').trim().toLowerCase() === 'on'

export function maxBusinessSolutionCount(
  openToSolutions: boolean,
  userTier: string,
  targetCount: number
): number {
  const raw = Math.floor(targetCount * BASE_CAP * (TIER_MULTIPLIERS[userTier] ?? 1.0))
  // Opted-in ⇒ guaranteed ≥1 provider at any cap; not opted-in ⇒ reduced (0 at low caps).
  const computed = openToSolutions ? Math.max(1, raw) : Math.floor(raw * PREFERENCE_ADJUSTMENT)
  if (BUSINESS_SOLUTION_THROTTLE_ENABLED) return computed
  // Floored at targetCount, which is PROVABLY non-binding: a member can never receive more
  // than targetCount introductions in total, so a provider quota of targetCount can never be
  // the constraint that rejects an edge. The original computation is preserved above and is
  // one environment variable away, rather than deleted.
  return Math.max(targetCount, computed)
}
