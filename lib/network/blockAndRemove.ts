import { createAdminClient } from '@/lib/supabase/admin'

export const REMOVAL_REINTRODUCTION_DAYS = 180

/**
 * Load the set of user ids that the given user has blocked OR that have blocked the given user.
 * Either direction is enough to hide the pair from each other.
 */
export async function getBlockedUserIdsFor(userId: string): Promise<Set<string>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('blocked_users')
    .select('user_id, blocked_user_id')
    .or(`user_id.eq.${userId},blocked_user_id.eq.${userId}`)
  if (error) {
    console.error('[getBlockedUserIdsFor] error:', error.message)
    return new Set()
  }
  const out = new Set<string>()
  for (const row of data || []) {
    if (row.user_id === userId) out.add(row.blocked_user_id)
    else out.add(row.user_id)
  }
  return out
}

/**
 * Check whether either user has blocked the other.
 */
export async function isBlockedPair(userA: string, userB: string): Promise<boolean> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('blocked_users')
    .select('id')
    .or(`and(user_id.eq.${userA},blocked_user_id.eq.${userB}),and(user_id.eq.${userB},blocked_user_id.eq.${userA})`)
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error('[isBlockedPair] error:', error.message)
    return false
  }
  return !!data
}

/**
 * Returns true if a match is currently "removed" AND still within the reintroduction cooldown.
 * After REMOVAL_REINTRODUCTION_DAYS have elapsed, the match is considered historical and no longer
 * blocks new recommendations.
 */
export function isWithinRemovalCooldown(removedAt: string | null | undefined): boolean {
  if (!removedAt) return false
  const removed = new Date(removedAt).getTime()
  if (Number.isNaN(removed)) return false
  const cutoff = Date.now() - REMOVAL_REINTRODUCTION_DAYS * 24 * 60 * 60 * 1000
  return removed > cutoff
}
