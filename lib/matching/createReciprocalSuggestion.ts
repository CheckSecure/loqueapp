import { isSelfPair } from '@/lib/matching/reciprocalPair'
import { RECOMMENDATIONS_PER_BATCH } from '@/lib/introductions/limits'

// THE single reciprocal creation path for every automatic generator (onboarding + weekly). It
// delegates to the transactional, race-safe RPC public.create_reciprocal_suggestion (migration
// 050): canonical pair claim + BOTH standard 'suggested' cards + all eligibility/privacy/CAPACITY
// re-checked inside the transaction under a row lock. The "Introduced by Andrel" label is rendered
// from the structured pair_id (client), NOT from match_reason — so `reason` here is an OPTIONAL
// genuine fit explanation, not the label.

export type ReciprocalOutcome = 'created' | 'exists_active' | 'cooldown' | 'capacity' | 'ineligible' | 'invalid' | 'error'

export interface ReciprocalResult {
  ok: boolean
  outcome: ReciprocalOutcome
}

export async function createReciprocalSuggestion(
  admin: any,
  aId: string,
  bId: string,
  opts?: { source?: string; reason?: string | null; cooldownDays?: number; maxCards?: number },
): Promise<ReciprocalResult> {
  if (!aId || !bId || isSelfPair(aId, bId)) return { ok: false, outcome: 'invalid' }
  const { data, error } = await admin.rpc('create_reciprocal_suggestion', {
    a_id: aId,
    b_id: bId,
    p_source: opts?.source ?? 'reciprocal',
    p_reason: opts?.reason ?? null,
    p_cooldown_days: opts?.cooldownDays ?? 30,
    p_max_cards: opts?.maxCards ?? RECOMMENDATIONS_PER_BATCH,
  })
  if (error) {
    console.error('[reciprocal-suggestion] rpc failed:', error.message)
    return { ok: false, outcome: 'error' }
  }
  const outcome = (data as ReciprocalOutcome) ?? 'error'
  return { ok: outcome === 'created', outcome }
}

// Weekly rotation: expire UNTOUCHED, stale reciprocal pairs (both directions atomically) so two
// idle cards can never block a member forever. Pairs with member activity on either side are
// protected in SQL. Returns the number of pairs expired.
export async function expireStaleReciprocalPairs(
  admin: any,
  opts?: { rotationDays?: number; limit?: number },
): Promise<{ expired: number }> {
  const { data, error } = await admin.rpc('expire_stale_reciprocal_pairs', {
    p_rotation_days: opts?.rotationDays ?? 14,
    p_limit: opts?.limit ?? 500,
  })
  if (error) {
    console.error('[reciprocal-rotation] rpc failed:', error.message)
    return { expired: 0 }
  }
  return { expired: typeof data === 'number' ? data : 0 }
}
