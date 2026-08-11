// Canonical, reciprocal member-pair model + fair counterpart selection.
//
// Every automatic introduction is an UNORDERED pair of two distinct members. We canonicalize a
// pair by sorting the two stable participant IDs, so (A,B) and (B,A) resolve to the SAME key/row —
// reversed duplicates are impossible and both participants resolve the same pair. Self-pairs are
// rejected. Fair selection spreads new members across eligible counterparts (least-loaded first)
// instead of repeatedly assigning the globally top-ranked person to everyone.

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
  /** how many ACTIVE inbound recommendations this candidate already holds (load signal) */
  inbound: number
  /** meaningful viewer-specific fit score; NEVER surfaced to members */
  score: number
}

// Fair exposure is a BOUNDED tie-breaker, not an override: a candidate with a materially higher fit
// still wins, but among near-equally-good candidates the one with less existing exposure is
// preferred — so no one becomes the default for everyone, and a poor-fit low-exposure candidate
// never beats a materially better one solely because of load.
export const EXPOSURE_PENALTY_CAP = 6   // max fit points exposure can ever shave off
export const EXPOSURE_PER_INBOUND = 2   // penalty per active inbound recommendation

/**
 * Choose the fairest counterpart:
 *   1. highest EXPOSURE-ADJUSTED fit = score − min(cap, inbound·perInbound) — bounded, so a
 *      candidate leading by more than the cap always wins regardless of load;
 *   2. tie → lower current inbound load (spreads near-ties);
 *   3. tie → deterministic id.
 * Returns null when there is no eligible counterpart (honest empty state; never a forced match).
 */
export function selectFairCounterpart(
  candidates: Counterpart[],
  opts?: { penaltyCap?: number; perInbound?: number },
): Counterpart | null {
  if (!candidates.length) return null
  const cap = opts?.penaltyCap ?? EXPOSURE_PENALTY_CAP
  const per = opts?.perInbound ?? EXPOSURE_PER_INBOUND
  const eff = (c: Counterpart) => c.score - Math.min(cap, Math.max(0, c.inbound) * per)
  return [...candidates].sort((x, y) =>
    (eff(y) - eff(x)) ||                        // bounded exposure-adjusted fit
    (x.inbound - y.inbound) ||                  // near-tie → lower load
    (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),   // deterministic tie-break
  )[0]
}

/**
 * Pick up to `n` DISTINCT counterparts, re-applying the bounded fair rule after each pick (each
 * selection raises that candidate's effective exposure), so a member's batch spreads across
 * good-fit members instead of stacking the single top candidate. Empty input → [] (honest empty).
 */
export function selectFairCounterparts(
  candidates: Counterpart[],
  n: number,
  opts?: { penaltyCap?: number; perInbound?: number },
): Counterpart[] {
  const pool = candidates.map(c => ({ ...c }))
  const picked: Counterpart[] = []
  while (picked.length < n && pool.length) {
    const next = selectFairCounterpart(pool, opts)!
    picked.push({ ...next })
    pool.splice(pool.findIndex(c => c.id === next.id), 1) // never pick the same counterpart twice
  }
  return picked
}
