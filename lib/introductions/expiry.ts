/**
 * Bounded expiry worker helpers.
 *
 * Two shapes, deliberately separate, because they do NOT have the same semantics:
 *
 *   RECIPROCAL (pair_id set) — two directional rows that must move together. Delegated entirely to
 *   public.expire_intro_pair (migration 066), which takes both members' advisory locks, re-reads
 *   state inside the transaction, and refuses on interest, match or terminal pair status. There is
 *   no client-side multi-statement path, because that is exactly what produced one-sided rows before.
 *
 *   LEGACY / ADMIN (pair_id NULL) — genuinely one-sided rows with no counterpart to synchronise.
 *   Expired individually, and ONLY while still 'suggested' and old enough. No counterpart is
 *   manufactured, and no historical closed row is touched.
 */

export const EXPIRY_AGE_DAYS = 14

export type PairExpiryOutcome = 'expired' | 'protected' | 'skipped' | 'invalid' | 'error'

export interface PairExpiryResult { outcome: PairExpiryOutcome; detail?: string | null }

export async function expireIntroPair(
  admin: any, pairId: string, maxAgeDays: number = EXPIRY_AGE_DAYS,
): Promise<PairExpiryResult> {
  const { data, error } = await admin.rpc('expire_intro_pair', {
    p_pair_id: pairId, p_max_age_days: maxAgeDays,
  })
  if (error) {
    // CLASS only — never a member id, a pair id, or a raw database message.
    console.error('[intro-expiry] rpc failed (class):', (error as any).code ?? 'unknown')
    return { outcome: 'error' }
  }
  const r = (data ?? {}) as Record<string, any>
  return { outcome: (r.outcome as PairExpiryOutcome) ?? 'error', detail: r.detail ?? null }
}

/** Outcomes that mean the pair is settled for this run and must not be retried immediately. */
export function isSettled(o: PairExpiryOutcome): boolean {
  return o === 'expired' || o === 'protected' || o === 'invalid'
}
