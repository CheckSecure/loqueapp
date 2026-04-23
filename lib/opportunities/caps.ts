/**
 * lib/opportunities/caps.ts
 *
 * All numeric policy constants for the Opportunities Engine live here.
 * Changing any value here should be deliberate — audit UI copy and tier comms.
 */

export type OpportunityType = 'hiring' | 'business';
export type Urgency = 'low' | 'medium' | 'urgent';
export type Tier = 'free' | 'professional' | 'executive' | 'founding';

// Max concurrent opportunities (status = active | dormant) a creator may hold.
export const TIER_OPPORTUNITY_LIMIT: Record<Tier, number> = {
  free: 0,
  professional: 1,
  executive: 2,
  founding: 1,
};

// Max responders who can click "Open to this" / "I can help" before the slot closes.
export const RESPONSE_CAP = {
  hiring: 8,
  business: 3,
  recruiter: 3,
} as const;

export const DELIVERY_CEILING = {
  hiring: 8,
  business: 3,
  recruiter: 3,
} as const;

export const RECRUITER_WEEKLY_CAP = 3;

export function computeExpiryDays(type: OpportunityType, urgency?: Urgency): number {
  if (type === 'hiring') return 21;
  if (urgency === 'urgent') return 7;
  if (urgency === 'medium') return 14;
  return 30;
}

export const INACTIVITY_NUDGE_DAYS = 5;
export const DORMANCY_DAYS = 10;
export const NUDGE_REPEAT_BLACKOUT_DAYS = 3;

export const OPPORTUNITY_NOTIF_SUPPRESSION_DAYS = 7;
export const REMOVED_MATCH_COOLDOWN_DAYS = 180;
export const CREATOR_MIN_ACCOUNT_AGE_DAYS = 14;
export const CREATOR_MIN_TRUST_SCORE = 0.4;

// Admin testing/seeding override. These emails bypass tier caps and trust checks
// on opportunity creation. Keep this list short and audited.
export const ADMIN_OVERRIDE_EMAILS = new Set<string>([
  'bizdev91@gmail.com',
]);
