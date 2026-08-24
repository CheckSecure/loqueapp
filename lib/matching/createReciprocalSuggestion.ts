import { isSelfPair } from '@/lib/matching/reciprocalPair'
import { MAX_VISIBLE_INTRO_CARDS } from '@/lib/introductions/capacity'

// THE single reciprocal creation path for every automatic generator (onboarding + weekly). It
// delegates to the transactional, race-safe RPC public.create_reciprocal_suggestion (migration
// 050): canonical pair claim + BOTH standard 'suggested' cards + all eligibility/privacy/CAPACITY
// re-checked inside the transaction under a row lock. The "Introduced by Andrel" label is rendered
// from the structured pair_id (client), NOT from match_reason — so `reason` here is an OPTIONAL
// genuine fit explanation, not the label.

// 'unresolved' (migration 081): one of the two members still owes a response on an introduction
// they already hold. A DETERMINISTIC skip, exactly like 'capacity' — never retried by
// walkCandidates, and self-clearing the moment that member acts.
export type ReciprocalOutcome = 'created' | 'exists_active' | 'cooldown' | 'capacity' | 'unresolved' | 'ineligible' | 'invalid' | 'error'

export interface ReciprocalResult {
  ok: boolean
  outcome: ReciprocalOutcome
}

export async function createReciprocalSuggestion(
  admin: any,
  aId: string,
  bId: string,
  // NOTE: there is deliberately no `maxCards` option. The visible cap is a constant inside the RPC
  // and cannot be raised from here; offering the knob would only invite a caller to try.
  opts?: {
    source?: string
    reason?: string | null
    cooldownDays?: number
    /**
     * The RELEASE ENVELOPE this placement belongs to (migration 081).
     *
     * Stamped on aId's card only, and excluded from aId's own unresolved count, so the second card
     * of a two-card release is not refused because the first one is unanswered. Omitting it makes
     * this an INDEPENDENT placement: aId must then be genuinely clear, which is what a coverage fill
     * or a one-off pairing should require.
     *
     * bId is never exempted by it. They are the counterpart of somebody else's release.
     */
    releaseId?: string | null
  },
): Promise<ReciprocalResult> {
  if (!aId || !bId || isSelfPair(aId, bId)) return { ok: false, outcome: 'invalid' }
  const { data, error } = await admin.rpc('create_reciprocal_suggestion', {
    a_id: aId,
    b_id: bId,
    p_source: opts?.source ?? 'reciprocal',
    p_reason: opts?.reason ?? null,
    p_cooldown_days: opts?.cooldownDays ?? 30,
    // p_max_cards is retained only because migration 050 defined this signature and PostgREST
    // resolves by argument list. The RPC CLAMPS it downward against its own constant, so this value
    // can never raise the cap; it is passed as the contract's number purely so the two agree.
    p_max_cards: MAX_VISIBLE_INTRO_CARDS,
    p_release_id: opts?.releaseId ?? null,
  })
  if (error) {
    // A deadline-cancelled RPC surfaces as an AbortError — never log the raw abort/payload. All
    // errors (incl. abort) map to the transient 'error' outcome; the caller retries idempotently
    // (the RPC's exists_active/canonical-pair guards make a re-attempt safe even if it committed).
    const aborted = error.name === 'AbortError' || /abort/i.test(error.message ?? '')
    if (!aborted) console.error('[reciprocal-suggestion] rpc failed (class):', error.code ?? 'unknown')
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
