/**
 * lib/opportunities/eligibility.ts
 *
 * Creator eligibility for signaling an opportunity.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import {
  TIER_OPPORTUNITY_LIMIT,
  CREATOR_MIN_ACCOUNT_AGE_DAYS,
  CREATOR_MIN_TRUST_SCORE,
  type Tier,
} from './caps';

export type EligibilityResult =
  | { ok: true }
  | { ok: false; code: EligibilityFailureCode; message: string };

export type EligibilityFailureCode =
  | 'profile_incomplete'
  | 'account_inactive'
  | 'tier_cap_reached'
  | 'trust_threshold'
  | 'free_tier';

export async function checkCreatorEligibility(userId: string): Promise<EligibilityResult> {
  const admin = createAdminClient();

  const { data: profile, error } = await admin
    .from('profiles')
    .select(
      'id, profile_complete, account_status, subscription_tier, is_founding_member, ' +
      'trust_score, created_at'
    )
    .eq('id', userId)
    .maybeSingle();

  if (error || !profile) {
    return { ok: false, code: 'profile_incomplete', message: 'Profile not found.' };
  }

  if (!profile.profile_complete) {
    return { ok: false, code: 'profile_incomplete', message: 'Complete your profile to signal a need.' };
  }

  if (profile.account_status !== 'active') {
    return { ok: false, code: 'account_inactive', message: 'Your account is not active.' };
  }

  const tier = (profile.subscription_tier as Tier) ?? 'free';
  const cap = TIER_OPPORTUNITY_LIMIT[tier] ?? 0;

  if (cap === 0) {
    return {
      ok: false,
      code: 'free_tier',
      message: 'Signaling a need is a Professional feature.',
    };
  }

  const { count: activeCount, error: countErr } = await admin
    .from('opportunities')
    .select('id', { count: 'exact', head: true })
    .eq('creator_id', userId)
    .in('status', ['active', 'dormant']);

  if (countErr) {
    return { ok: false, code: 'tier_cap_reached', message: 'Unable to verify limit. Try again.' };
  }

  if ((activeCount ?? 0) >= cap) {
    return {
      ok: false,
      code: 'tier_cap_reached',
      message: cap === 1
        ? 'You already have an active signal. Close it first.'
        : `You have reached your limit of ${cap} active signals.`,
    };
  }

  if (profile.is_founding_member) return { ok: true };

  const { count: activeMatches } = await admin
    .from('matches')
    .select('id', { count: 'exact', head: true })
    .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)
    .eq('status', 'active')
    .is('removed_at', null);

  if ((activeMatches ?? 0) >= 1) return { ok: true };

  const ageMs = Date.now() - new Date(profile.created_at).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const trust = Number(profile.trust_score ?? 0);

  if (ageDays >= CREATOR_MIN_ACCOUNT_AGE_DAYS && trust >= CREATOR_MIN_TRUST_SCORE) {
    return { ok: true };
  }

  return {
    ok: false,
    code: 'trust_threshold',
    message: 'Your account is new. This feature unlocks once you complete at least one introduction.',
  };
}
