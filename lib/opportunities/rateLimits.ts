/**
 * lib/opportunities/rateLimits.ts
 *
 * Prompt #15 Step 5: rate-limit gates for candidate delivery.
 *
 * Returns the set of user IDs who are currently rate-limited and MUST be
 * excluded from delivery. Runs BEFORE scoring in the matcher gate chain.
 *
 * Gates:
 *   1. MAX_ACTIVE_IN_FOR_YOU — user has too many active opportunity cards
 *   2. MAX_DELIVERIES_PER_7_DAYS — too many recent deliveries
 *   3. MAX_DELIVERIES_PER_30_DAYS — too many monthly deliveries
 *   4. MAX_APPEARANCES_PER_30_DAYS — too many appearances in any candidate pool
 *   5. SAME_PAIR_INTRO_COOLDOWN_DAYS — this creator already introduced this user within 90 days
 */

import { createAdminClient } from '@/lib/supabase/admin';
import {
  MAX_ACTIVE_IN_FOR_YOU_BY_TIER,
  MAX_DELIVERIES_PER_7_DAYS,
  MAX_DELIVERIES_PER_30_DAYS,
  MAX_APPEARANCES_PER_30_DAYS,
  SAME_PAIR_INTRO_COOLDOWN_DAYS,
  type Tier,
} from './caps';

/**
 * Return the set of user IDs who should NOT receive a new opportunity delivery
 * from the given creator right now due to rate limits.
 */
export async function rateLimitedUserIds(creatorId: string): Promise<Set<string>> {
  const admin = createAdminClient();
  const now = Date.now();
  const cutoff7 = new Date(now - 7 * 86400_000).toISOString();
  const cutoff30 = new Date(now - 30 * 86400_000).toISOString();
  const cutoff90 = new Date(now - SAME_PAIR_INTRO_COOLDOWN_DAYS * 86400_000).toISOString();

  const limited = new Set<string>();

  // Gate 1: MAX_ACTIVE_IN_FOR_YOU
  // Active = candidate row exists, dismissed_at IS NULL, underlying opportunity is 'active',
  // user has NOT responded (no opportunity_responses row for the same opportunity).
  //
  // Implementation: count per user, filter to users at/above cap.
  const { data: activeCards } = await admin
    .from('opportunity_candidates')
    .select('user_id, opportunity_id, dismissed_at, opportunities!inner(status, archived_at)')
    .is('dismissed_at', null)
    .eq('opportunities.status', 'active')
    .is('opportunities.archived_at', null);

  if (activeCards) {
    // Fetch user's responses so we can exclude responded cards from the count.
    const userIds = Array.from(new Set(activeCards.map((c: any) => c.user_id)));
    if (userIds.length > 0) {
      const { data: responses } = await admin
        .from('opportunity_responses')
        .select('user_id, opportunity_id')
        .in('user_id', userIds);
      const respondedSet = new Set(
        (responses ?? []).map((r: any) => `${r.user_id}:${r.opportunity_id}`)
      );
      const activeCountByUser = new Map<string, number>();
      for (const c of activeCards) {
        const key = `${c.user_id}:${c.opportunity_id}`;
        if (respondedSet.has(key)) continue;
        activeCountByUser.set(c.user_id, (activeCountByUser.get(c.user_id) ?? 0) + 1);
      }
      // Tier-aware cap: free users max 2, paid tiers max 5. Pull each
      // user's subscription_tier and apply the tier-specific cap.
      const uidsToCheck = Array.from(activeCountByUser.keys());
      if (uidsToCheck.length > 0) {
        const { data: tierRows } = await admin
          .from('profiles')
          .select('id, subscription_tier')
          .in('id', uidsToCheck);
        const tierMap = new Map(
          (tierRows ?? []).map((t: any) => [t.id as string, ((t.subscription_tier as string) || 'free') as Tier])
        );
        for (const [uid, count] of Array.from(activeCountByUser.entries())) {
          const tier = tierMap.get(uid) ?? 'free';
          const cap = MAX_ACTIVE_IN_FOR_YOU_BY_TIER[tier] ?? MAX_ACTIVE_IN_FOR_YOU_BY_TIER.free;
          if (count >= cap) limited.add(uid);
        }
      }
    }
  }

  // Gate 2+3+4: delivery/appearance caps.
  // All three read from opportunity_candidates with different time windows.
  // Fetch 30-day window once, derive 7-day from subset.
  const { data: recentCandidates } = await admin
    .from('opportunity_candidates')
    .select('user_id, shown_at')
    .gte('shown_at', cutoff30);

  if (recentCandidates) {
    const deliveries30 = new Map<string, number>();
    const deliveries7 = new Map<string, number>();
    for (const row of recentCandidates) {
      const uid = row.user_id as string;
      deliveries30.set(uid, (deliveries30.get(uid) ?? 0) + 1);
      if (row.shown_at && row.shown_at >= cutoff7) {
        deliveries7.set(uid, (deliveries7.get(uid) ?? 0) + 1);
      }
    }
    for (const [uid, count] of Array.from(deliveries7.entries())) {
      if (count >= MAX_DELIVERIES_PER_7_DAYS) limited.add(uid);
    }
    for (const [uid, count] of Array.from(deliveries30.entries())) {
      if (count >= MAX_DELIVERIES_PER_30_DAYS) limited.add(uid);
      if (count >= MAX_APPEARANCES_PER_30_DAYS) limited.add(uid);
    }
  }

  // Gate 5: Same-pair introduction cooldown.
  // If creator introduced this user via an opportunity in the last 90 days,
  // block re-delivery. Uses matches.opportunity_id + is_opportunity_initiated.
  // Decline does NOT trigger this — only a successful introduction.
  // Only consider matches that are STILL active. A removed/unmatched pair
  // releases the pair cooldown — removal is a stronger signal than decline
  // that the parties shouldn't be bound by the original connection.
  const { data: recentIntros } = await admin
    .from('matches')
    .select('user_a_id, user_b_id, opportunity_id, created_at, status, removed_at')
    .or(`user_a_id.eq.${creatorId},user_b_id.eq.${creatorId}`)
    .eq('is_opportunity_initiated', true)
    .gte('created_at', cutoff90)
    .is('removed_at', null);

  for (const m of recentIntros ?? []) {
    const peer = m.user_a_id === creatorId ? m.user_b_id : m.user_a_id;
    limited.add(peer);
  }

  return limited;
}
