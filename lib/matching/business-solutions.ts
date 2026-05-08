/**
 * lib/matching/business-solutions.ts
 *
 * Shared helpers for classifying and throttling business-solution providers
 * (law firms, consultants, etc.) in both the live recommendation path and
 * the admin batch generation path.
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
 * Returns the maximum number of business-solution providers allowed in a
 * batch of `targetCount` for a given user.
 *
 * Mirrors the throttle logic in applyThrottling() in generate-recommendations.ts.
 * Both paths must stay in sync — change this file, not the callers.
 */
export function maxBusinessSolutionCount(
  openToSolutions: boolean,
  userTier: string,
  targetCount: number
): number {
  let cap = Math.floor(targetCount * BASE_CAP * (TIER_MULTIPLIERS[userTier] ?? 1.0))
  if (!openToSolutions) {
    cap = Math.floor(cap * PREFERENCE_ADJUSTMENT)
  }
  // Guarantee at least 1 only when user is explicitly open to solutions
  if (cap === 0 && targetCount >= 3 && openToSolutions) {
    cap = 1
  }
  return cap
}
