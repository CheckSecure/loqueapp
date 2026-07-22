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

export function isBusinessSolutionProvider(candidate: { role_type?: string }): boolean {
  const roleType = (candidate.role_type || '').toLowerCase()
  return (
    roleType.includes('law firm') ||
    roleType.includes('consultant') ||
    roleType.includes('legal services') ||
    roleType.includes('legal tech')
  )
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
export function maxBusinessSolutionCount(
  openToSolutions: boolean,
  userTier: string,
  targetCount: number
): number {
  const raw = Math.floor(targetCount * BASE_CAP * (TIER_MULTIPLIERS[userTier] ?? 1.0))
  // Opted-in ⇒ guaranteed ≥1 provider at any cap; not opted-in ⇒ reduced (0 at low caps).
  return openToSolutions ? Math.max(1, raw) : Math.floor(raw * PREFERENCE_ADJUSTMENT)
}
