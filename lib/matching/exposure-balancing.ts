// Exposure balancing — rank-only penalty that discourages concentrating inbound
// recommendations on a handful of popular members.
//
// Applies AFTER the >=10 eligibility gate, on rankingScore (never finalScore, never
// the deterministic alignment core), so it only REORDERS already-eligible
// candidates and can never promote a sub-threshold candidate into the batch.
// Deterministic: the penalty is a pure function of a candidate's CURRENT active
// inbound recommendation count — no randomness.
//
// Flag gate: process.env.RECOMMENDATION_EXPOSURE_BALANCING === '1'. When off,
// exposureBalancingEnabled() is false and the caller skips it entirely, so live
// generation is byte-identical to current behavior.

export interface ExposureBalancingConfig {
  /** Inbound count at/below which no penalty applies — the "fair share" floor. */
  softFloor: number
  /** Score points subtracted per inbound recommendation above the floor. */
  penaltyPerUnit: number
  /** Hard cap on the total penalty — bounds how much alignment it can override. */
  maxPenalty: number
}

// Tuned so the cap (6) is smaller than a meaningful alignment gap: a candidate
// who leads by more than 6 ranking points still wins regardless of exposure, so
// balancing only ever decides near-ties. softFloor 2 = the per-member batch size,
// i.e. everyone gets a "fair share" of 2 before any penalty applies.
export const DEFAULT_EXPOSURE_BALANCING: ExposureBalancingConfig = {
  softFloor: 2,
  penaltyPerUnit: 1.5,
  maxPenalty: 6,
}

/** Whether exposure balancing is enabled for live generation. */
export function exposureBalancingEnabled(): boolean {
  return process.env.RECOMMENDATION_EXPOSURE_BALANCING === '1'
}

/**
 * Deterministic, capped penalty for one candidate's current inbound exposure.
 * Zero at/below the floor; grows linearly above it; never exceeds maxPenalty.
 */
export function exposurePenalty(
  inboundCount: number,
  config: ExposureBalancingConfig = DEFAULT_EXPOSURE_BALANCING,
): number {
  const over = Math.max(0, (inboundCount ?? 0) - config.softFloor)
  return Math.min(config.maxPenalty, over * config.penaltyPerUnit)
}

/**
 * Rank-only re-sort that subtracts a capped exposure penalty from each
 * candidate's rankingScore. Pure and deterministic — no env read, no I/O; the
 * caller supplies the exposure map and (optionally) config. Stable: equal
 * adjusted scores preserve input order, so the deterministic tie-breaks upstream
 * are respected.
 *
 * Returns the input array unchanged when no candidate carries above-floor
 * exposure (nothing to penalize).
 */
export function applyExposureBalancing(
  candidates: any[],
  exposureByUserId: Map<string, number> | Record<string, number>,
  config: ExposureBalancingConfig = DEFAULT_EXPOSURE_BALANCING,
): any[] {
  const get = (id: string): number =>
    exposureByUserId instanceof Map ? exposureByUserId.get(id) ?? 0 : exposureByUserId[id] ?? 0

  let anyPenalized = false
  const adjusted = candidates.map((c, i) => {
    const penalty = exposurePenalty(get(c.id), config)
    if (penalty > 0) anyPenalized = true
    // rankingScore is the ranking key (set by applyTierRankingAdjustment); fall
    // back to finalScore for callers/tests that only carry the alignment score.
    return { c, i, adj: (c.rankingScore ?? c.finalScore ?? 0) - penalty }
  })
  if (!anyPenalized) return candidates
  return adjusted.sort((a, b) => b.adj - a.adj || a.i - b.i).map((x) => x.c)
}
