/**
 * lib/concierge/eligibility.ts
 *
 * Server-authoritative eligibility for the admin-assisted Concierge flow.
 * Mirrors the shape/error style of lib/opportunities/eligibility.ts.
 *
 * Tier resolution is delegated to getEffectiveTier() — do NOT reimplement
 * founding-member / expiry logic here.
 */

import { getEffectiveTier } from '@/lib/tier-override'

export const CONCIERGE_ALLOWED_TIERS = ['professional', 'executive', 'founding'] as const

export type ConciergeFailureCode =
  | 'profile_incomplete'
  | 'account_inactive'
  | 'free_tier'

export type ConciergeEligibilityResult =
  | { ok: true; tier: string }
  | { ok: false; code: ConciergeFailureCode; message: string }

/**
 * Pure gate over an already-loaded profile. Caller is responsible for loading
 * the profile from the authenticated session (never from request input).
 *
 * Gate order (each a distinct structured failure):
 *   1. profile_complete must be true
 *   2. account_status must equal 'active'
 *   3. getEffectiveTier() must be professional | executive | founding
 */
export function checkConciergeEligibility(profile: any): ConciergeEligibilityResult {
  if (!profile) {
    return { ok: false, code: 'profile_incomplete', message: 'Profile not found.' }
  }

  if (!profile.profile_complete) {
    return {
      ok: false,
      code: 'profile_incomplete',
      message: 'Complete your profile to use Concierge.',
    }
  }

  if (profile.account_status !== 'active') {
    return {
      ok: false,
      code: 'account_inactive',
      message: 'Your account is not active.',
    }
  }

  const tier = getEffectiveTier(profile)
  if (!CONCIERGE_ALLOWED_TIERS.includes(tier as (typeof CONCIERGE_ALLOWED_TIERS)[number])) {
    return {
      ok: false,
      code: 'free_tier',
      message: 'Concierge is available on Professional, Executive, and Founding plans.',
    }
  }

  return { ok: true, tier }
}
