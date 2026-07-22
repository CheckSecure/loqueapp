import { effectiveTierDistribution } from './batch-scoring'

/**
 * Per-recipient introduction-limit enforcement.
 *
 * A member must never receive more introductions in a batch than their tier
 * allows (`BATCH_CONFIG.tierDistribution[tier].total` — e.g. 3 on free). The main
 * generation path already caps this during selection, but `enforceRecipientLimits`
 * is a FINAL, source-independent invariant applied immediately before persistence
 * in every write path, so no upstream bug (e.g. a replacement mis-count) can ever
 * push a member over their limit.
 */

/**
 * Statuses that do NOT count toward a recipient's live introduction total — a
 * dropped or permanently-hidden suggestion has been removed, so it frees a slot.
 * Everything else (generated / shown / active / accepted / passed) counts as an
 * introduction the member has received this batch.
 */
export const NON_COUNTING_STATUSES = new Set(['dropped', 'hidden_permanent'])

export function suggestionCountsTowardLimit(status: string | null | undefined): boolean {
  return !NON_COUNTING_STATUSES.has(String(status ?? ''))
}

/** Configured per-batch introduction limit for a member's tier (after the launch cap). */
export function perRecipientIntroLimit(tier: string | null | undefined): number {
  return effectiveTierDistribution(tier).total
}

/**
 * Keep only as many new rows per recipient as fit under their limit, given how
 * many live suggestions they already have. Rows are consumed in priority order,
 * so the highest-quality suggestions are the ones kept. Returns the kept rows and
 * a per-recipient count of anything trimmed (log it — trimming means an upstream
 * bug produced excess, which should be investigated even though the invariant made
 * the output safe).
 */
export function enforceRecipientLimits<T extends { recipient_id: string }>(
  newRows: T[],
  limitOf: (recipientId: string) => number,
  existingLiveOf: (recipientId: string) => number = () => 0,
): { kept: T[]; dropped: Record<string, number> } {
  const running: Record<string, number> = {}
  const kept: T[] = []
  const dropped: Record<string, number> = {}
  for (const row of newRows) {
    const rid = row.recipient_id
    if (!(rid in running)) running[rid] = existingLiveOf(rid)
    if (running[rid] < limitOf(rid)) { kept.push(row); running[rid]++ }
    else dropped[rid] = (dropped[rid] ?? 0) + 1
  }
  return { kept, dropped }
}
