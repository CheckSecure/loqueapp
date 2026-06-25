/**
 * Single source of truth for the number of ACTIVE introductions maintained
 * per member.
 *
 * Launch (Stage A): all tiers are normalized to 3. Previously this value was
 * duplicated across four files as tier→count maps — TIER_RECOMMENDATION_COUNTS
 * in lib/generate-recommendations.ts and TIER_ACTIVE_SLOTS in the daily, weekly,
 * and monthly crons — with a Founding inconsistency (3 in onboarding/daily, 5 in
 * weekly/monthly). Those maps now all resolve here.
 */
export const ACTIVE_INTRO_CAP = 3

/**
 * Active-introduction cap for a given tier. For launch every tier returns
 * ACTIVE_INTRO_CAP (3). The tier parameter is accepted (and currently ignored)
 * so a future stage can reintroduce per-tier caps in exactly one place without
 * touching any call site.
 */
export function getActiveIntroCap(_tier?: string): number {
  return ACTIVE_INTRO_CAP
}
