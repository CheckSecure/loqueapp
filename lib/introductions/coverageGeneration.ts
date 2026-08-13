import type { GenerationOutcome } from '@/lib/generate-recommendations'

/**
 * Weekly COVERAGE generation: fill eligible members who currently have NO active suggested/queued card
 * with a reciprocal "Introduced by Andrel" pair via the canonical create_reciprocal_suggestion path
 * (atomic two-sided, all existing active-pair/cooldown/canonical/capacity/duplicate guards).
 *
 * WHY THIS IS SAFE TO RUN BY DEFAULT (unlike the broad WEEKLY_REFRESH_GENERATION flag): coverage only
 * fills EMPTY slots. A member the admin batch already filled has an active card → excluded here; the
 * generator is idempotent (capacity/exists_active guards), so it can never create a duplicate pair or
 * compete with the admin batch. It never creates a one-sided card and never notifies (the reciprocal
 * flow notifies only on mutual finalization). Legacy status='approved' rows are NOT active cards
 * (capacity counts only suggested/queued), so a member with only legacy one-sided interest is covered
 * without touching those rows, and the generator's history exclusion keeps their prior counterparts out.
 *
 * A kill-switch env var WEEKLY_COVERAGE_GENERATION='off' disables it; anything else (incl. unset) = ON.
 */

export const COVERAGE_MEMBER_LIMIT = 25     // hard cap on members covered per weekly run
export const COVERAGE_DEADLINE_MS = 45_000  // overall wall-clock budget; no new member started past it

/** Coverage runs by DEFAULT; only an explicit 'off' disables it. */
export function coverageEnabled(): boolean {
  return (process.env.WEEKLY_COVERAGE_GENERATION ?? '').trim().toLowerCase() !== 'off'
}

export type CoverageEvent = 'covered' | 'no_candidate' | 'at_capacity' | 'transient' | 'ineligible'

/** Map a generator outcome to a coarse, non-identifying coverage tally bucket. */
export function coverageEventForOutcome(outcome: GenerationOutcome): CoverageEvent {
  switch (outcome) {
    case 'created': return 'covered'
    case 'empty_pool':
    case 'no_compatible_candidate': return 'no_candidate'  // honest classified outcome — never a weak/one-sided fallback
    case 'noop_at_capacity':
    case 'capacity': return 'at_capacity'
    case 'ineligible': return 'ineligible'
    default: return 'transient'  // transient_error / unexpected → retried on the next weekly run
  }
}

/**
 * PURE selection of members to cover: the eligible members with NO active suggested/queued card,
 * bounded to `limit`. Zero-card members are prioritized by construction (only they are returned). The
 * CALLER supplies the member order (a fair, non-signup order); candidate PAIRING quality is the
 * generator's job (compatibility scoring + fair-exposure ordering, unchanged).
 */
export function selectCoverageMembers(
  eligibleIds: string[],
  withActiveCard: ReadonlySet<string>,
  limit = COVERAGE_MEMBER_LIMIT,
): string[] {
  const out: string[] = []
  for (const id of eligibleIds) {
    if (withActiveCard.has(id)) continue // already has a card → not a coverage gap
    out.push(id)
    if (out.length >= limit) break
  }
  return out
}
