// Canonical, reciprocal member-pair model + fair counterpart selection.
//
// Every automatic introduction is an UNORDERED pair of two distinct members. We canonicalize a
// pair by sorting the two stable participant IDs, so (A,B) and (B,A) resolve to the SAME key/row —
// reversed duplicates are impossible and both participants resolve the same pair. Self-pairs are
// rejected. Fair selection spreads new members across eligible counterparts (least-loaded first)
// instead of repeatedly assigning the globally top-ranked person to everyone.

import { exposurePenalty, type CardCounts } from '@/lib/introductions/capacity'

export function isSelfPair(a: string, b: string): boolean {
  return a === b
}

/** Canonical ordered tuple [lo, hi] for two DISTINCT ids (throws on a self-pair). */
export function canonicalPair(a: string, b: string): [string, string] {
  if (isSelfPair(a, b)) throw new Error('canonicalPair: self-pair not allowed')
  return a < b ? [a, b] : [b, a]
}

/** Stable, order-independent key for a pair — (A,B) and (B,A) map to the same string. */
export function canonicalPairKey(a: string, b: string): string {
  const [lo, hi] = canonicalPair(a, b)
  return `${lo}:${hi}`
}

export interface Counterpart {
  id: string
  /**
   * Active inbound exposure, kept as TWO signals because they mean different things: `visible`
   * cards are already on someone's screen, `reserved` ones have been shown to nobody. Collapsing
   * them into a single number saturated the bounded penalty for 59% of candidates on production,
   * which silently turned fair ordering back into pure score ordering.
   */
  exposure: CardCounts
  /** meaningful viewer-specific fit score; NEVER surfaced to members */
  score: number
}

// Fair exposure is a BOUNDED tie-breaker, not an override: a candidate with a materially higher fit
// still wins, but among near-equally-good candidates the one with less existing exposure is
// preferred — so no one becomes the default for everyone, and a poor-fit low-exposure candidate
// never beats a materially better one solely because of load.
// The penalty itself lives in the capacity contract (lib/introductions/capacity), so the tiers,
// their weights and their caps are defined exactly once:
//   visible  2 points each, capped at 6
//   reserved 1 point each,  capped at 2   → maximum total 8
export {
  VISIBLE_PENALTY_PER_CARD,
  VISIBLE_PENALTY_CAP,
  RESERVED_PENALTY_PER_CARD,
  RESERVED_PENALTY_CAP,
  MAX_EXPOSURE_PENALTY,
  // Legacy names kept so existing imports keep compiling; they now name the VISIBLE tier only.
  VISIBLE_PENALTY_CAP as EXPOSURE_PENALTY_CAP,
  VISIBLE_PENALTY_PER_CARD as EXPOSURE_PER_INBOUND,
} from '@/lib/introductions/capacity'

/**
 * Choose the fairest counterpart:
 *   1. highest EXPOSURE-ADJUSTED fit = score − exposurePenalty(exposure) — bounded at 8 points,
 *      so a candidate leading by more than that always wins regardless of load;
 *   2. tie → lower current load, a visible card weighing more than a reservation;
 *   3. tie → deterministic id.
 * The weights are NOT injectable: one authoritative definition in lib/introductions/capacity is the
 * whole point, and a per-call override is how the two systems drifted apart before.
 * Returns null when there is no eligible counterpart (honest empty state; never a forced match).
 */
export function selectFairCounterpart(candidates: Counterpart[]): Counterpart | null {
  if (!candidates.length) return null
  const eff = (c: Counterpart) => c.score - exposurePenalty(c.exposure)
  // Near-tie → prefer the candidate carrying less load, weighting an already-VISIBLE card above a
  // reservation nobody has seen.
  const load = (c: Counterpart) => c.exposure.visible * 2 + c.exposure.reserved
  return [...candidates].sort((x, y) =>
    (eff(y) - eff(x)) ||                        // bounded exposure-adjusted fit
    (load(x) - load(y)) ||                      // near-tie → lower load
    (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),   // deterministic tie-break
  )[0]
}

/**
 * Pick up to `n` DISTINCT counterparts, re-applying the bounded fair rule after each pick (each
 * selection raises that candidate's effective exposure), so a member's batch spreads across
 * good-fit members instead of stacking the single top candidate. Empty input → [] (honest empty).
 */
export function selectFairCounterparts(candidates: Counterpart[], n: number): Counterpart[] {
  const pool = candidates.map(c => ({ ...c, exposure: { ...c.exposure } }))
  const picked: Counterpart[] = []
  while (picked.length < n && pool.length) {
    const next = selectFairCounterpart(pool)!
    picked.push({ ...next, exposure: { ...next.exposure } })
    pool.splice(pool.findIndex(c => c.id === next.id), 1) // never pick the same counterpart twice
  }
  return picked
}
