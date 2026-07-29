/**
 * Tiered introduction-history exclusion for NEW recommendation generation.
 *
 * A pair becomes ineligible for a new recommendation once it has been genuinely
 * PRESENTED to either member. History is split into two tiers plus an artifact
 * carve-out, so an exhaustion safety valve can relax the softer tier without ever
 * re-recommending a committed or explicitly-rejected pair.
 *
 *  • HARD (permanent, ignores the safety valve): engagement / commitment /
 *    explicit-signal statuses — pending, accepted, admin_pending, approved,
 *    declined, rejected, hidden, hidden_permanent — plus the ACTIVE window
 *    (suggested / queued: on-screen or queued-to-show, never a duplicate).
 *    matches / blocked_users / referrals are HARD too but live in other tables
 *    and are merged in by the caller.
 *
 *  • SOFT (releasable by the safety valve): genuinely shown but no commitment —
 *    passed, expired, and archived rows that belonged to a real (displayed)
 *    batch. These stay excluded until a member is exhausted, then the valve
 *    lets them return.
 *
 *  • ARTIFACT (never history): archived rows with NO batch_id — the
 *    migration/backfill mass-archive that was never part of a displayed batch,
 *    i.e. never genuinely presented. These never make a pair ineligible.
 *
 * The sole never-shown exception (a queued recommendation discarded before it was
 * ever displayed) needs no status handling: discardQueuedBatch DELETEs the row,
 * so it simply isn't present here. Classification is bidirectional.
 */

// Engagement / commitment / explicit signal — permanent, valve never releases.
// `accepted_pending_payment` is a committed acceptance mid-payment: it must NEVER
// be re-recommended while the transaction settles.
export const HARD_HISTORY_STATUSES = new Set<string>([
  'pending', 'accepted', 'accepted_pending_payment', 'admin_pending', 'approved', 'declined', 'rejected', 'hidden', 'hidden_permanent',
])
// Live rows occupying the member's window — always excluded (never a duplicate).
export const ACTIVE_STATUSES = new Set<string>(['suggested', 'queued'])
// Genuinely presented, no commitment — releasable by the safety valve.
export const SOFT_HISTORY_STATUSES = new Set<string>(['passed', 'expired'])

export interface IntroHistoryRow {
  requester_id: string
  target_user_id: string
  status?: string | null
  batch_id?: string | null
}

export interface ClassifiedHistory {
  /** Permanent — excluded regardless of the safety valve. */
  hardExcluded: Set<string>
  /** Releasable — excluded normally, dropped when the valve engages. */
  softExcluded: Set<string>
}

/**
 * Split the other party of every intro_requests row (bidirectional) into hard vs
 * soft exclusions. Backfill artifacts (archived + no batch_id) are dropped from
 * both — they never create history. A pair that is HARD anywhere is never left in
 * the soft set (hard dominates).
 */
export function classifyIntroHistory(
  userId: string,
  rows: IntroHistoryRow[] | null | undefined,
): ClassifiedHistory {
  const hard = new Set<string>()
  const soft = new Set<string>()
  for (const r of rows ?? []) {
    if (!r) continue
    const other = r.requester_id === userId ? r.target_user_id : r.target_user_id === userId ? r.requester_id : null
    if (!other || other === userId) continue
    const s = r.status ?? ''
    if (ACTIVE_STATUSES.has(s) || HARD_HISTORY_STATUSES.has(s)) {
      hard.add(other)
    } else if (SOFT_HISTORY_STATUSES.has(s)) {
      soft.add(other)
    } else if (s === 'archived') {
      // Genuinely shown (belonged to a displayed batch) → soft; otherwise it is a
      // migration/backfill artifact (no batch_id) → not history at all.
      if (r.batch_id) soft.add(other)
    }
    // Unknown/legacy status → ignored (never invent an exclusion).
  }
  for (const id of Array.from(hard)) soft.delete(id) // hard dominates
  return { hardExcluded: hard, softExcluded: soft }
}

/** True when an intro_requests row counts as genuine introduction history (a pair
 *  that was presented / acted on / is live). Backfill artifacts (archived with no
 *  batch_id) are NOT history. Mirrors classifyIntroHistory's status rules so both
 *  stay in lockstep. */
export function isIntroHistoryRow(status: string | null | undefined, batchId: string | null | undefined): boolean {
  const s = status ?? ''
  if (ACTIVE_STATUSES.has(s) || HARD_HISTORY_STATUSES.has(s) || SOFT_HISTORY_STATUSES.has(s)) return true
  if (s === 'archived') return !!batchId // shown (belonged to a real batch) → history; artifact → not
  return false // unknown/legacy → never invent an exclusion
}

/**
 * Build a BIDIRECTIONAL exclusion map (userId → set of other userIds it has intro
 * history with) from raw intro_requests rows. Used by producers that select over
 * pairs (e.g. the admin reciprocal batch generator) so a pair already presented in
 * the queue is never re-recommended. Combines the HARD, ACTIVE and SOFT tiers and
 * drops migration artifacts — the same universe as classifyIntroHistory's
 * hardExcluded ∪ softExcluded, but keyed both ways for O(1) pair lookups.
 */
export function buildIntroHistoryExclusions(rows: IntroHistoryRow[] | null | undefined): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  const add = (a: string, b: string) => {
    let set = map.get(a)
    if (!set) { set = new Set<string>(); map.set(a, set) }
    set.add(b)
  }
  for (const r of rows ?? []) {
    if (!r || !r.requester_id || !r.target_user_id || r.requester_id === r.target_user_id) continue
    if (!isIntroHistoryRow(r.status, r.batch_id)) continue
    add(r.requester_id, r.target_user_id)
    add(r.target_user_id, r.requester_id)
  }
  return map
}

/**
 * Configurable exhaustion safety-valve threshold (env RECOMMENDATION_EXHAUSTION_THRESHOLD).
 * When a member's fresh candidate pool (after HARD + same-company exclusions, with
 * SOFT still applied) falls BELOW this many candidates, the SOFT tier is released
 * for that member so the weekly engine doesn't go dry.
 *
 * Operational guidance:
 *   • 0 (the DEFAULT) DISABLES the valve entirely — the SOFT tier stays permanent.
 *     This is the production default and it should remain disabled until monitoring
 *     shows members approaching exhaustion.
 *   • A future INITIAL value of 10 is recommended for a small or static network
 *     (~4–6× the per-batch size gives the valve headroom to engage before the pool
 *     collapses — simulation shows depletion is a cliff, so a low threshold like 5
 *     fires too late).
 *   • Only enable it (set a positive integer) AFTER the pool-health monitor
 *     (GET /api/admin/pool-health) shows members trending toward the 10/5 buckets.
 *
 * matches / blocked / referrals / accepted / approved / pending / declined /
 * rejected / hidden / hidden_permanent are HARD and are NEVER released by the valve.
 */
export function exhaustionThreshold(): number {
  const raw = Number(process.env.RECOMMENDATION_EXHAUSTION_THRESHOLD)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
}
