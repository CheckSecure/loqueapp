/**
 * PRE-WRITE INVARIANT VALIDATION for admin batch generation.
 *
 * WHY THIS EXISTS. The deployed generator produced review batch 4 with 5 pairs where BOTH members
 * were already full and 17 more where one was, because the deficit it handed the optimizer folded
 * RESERVED capacity into VISIBLE capacity while migration 064 places pairs into the visible tier
 * only. A member holding 2 visible and 0 reserved cards was scored as having a deficit of 2.
 *
 * The approval RPC would have refused every one of those pairs, so no member card was ever at risk
 * — but a review batch full of unapprovable proposals wastes the operator's review and hides real
 * coverage. Generation must not rely on approval to catch generation's own mistakes.
 *
 * This module is PURE: it takes the solver's result and the same immutable capacity snapshot the
 * solver was given, and answers whether the result may be written. It performs no I/O, holds no
 * identities in its output, and is exercised behaviourally rather than by reading source strings.
 */

export interface InvariantEdge {
  userA: { id: string }
  userB: { id: string }
}

export interface CapacitySnapshot {
  /** visible_count(member) — cards with status 'suggested' where requester_id = member. */
  visibleByMember: ReadonlyMap<string, number>
  /** The product maximum. Always 2 today; passed explicitly so no constant is re-derived here. */
  maxVisible: number
}

export type InvariantCode =
  | 'member_missing_from_capacity_snapshot'
  | 'member_already_full'
  | 'member_degree_exceeds_deficit'
  | 'self_pair'
  | 'duplicate_unordered_pair'
  | 'projected_visible_exceeds_max'
  | 'directional_rows_mismatch'
  | 'asymmetric_proposal_rows'

export interface InvariantResult {
  ok: boolean
  /** Aggregate counts only — never a member id, name, email or company. */
  violations: Record<string, number>
}

export function visibleDeficit(visible: number, maxVisible: number): number {
  return Math.max(0, maxVisible - visible)
}

/**
 * Validate a solver result against the snapshot it was solved from.
 *
 * `directionalRows` is the fan-out about to be inserted. Passing it lets the validator prove the
 * symmetric expansion did not distort anything — exactly two rows per pair, one per direction.
 */
export function validateGeneration(
  selected: readonly InvariantEdge[],
  snapshot: CapacitySnapshot,
  directionalRows: readonly { recipient_id: string; suggested_id: string }[],
): InvariantResult {
  const v: Record<string, number> = {}
  const bump = (c: InvariantCode) => { v[c] = (v[c] ?? 0) + 1 }
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

  const degree = new Map<string, number>()
  const seenPairs = new Set<string>()

  for (const e of selected) {
    const a = e.userA?.id, b = e.userB?.id
    if (!a || !b || a === b) { bump('self_pair'); continue }
    const k = key(a, b)
    if (seenPairs.has(k)) { bump('duplicate_unordered_pair'); continue }
    seenPairs.add(k)
    degree.set(a, (degree.get(a) ?? 0) + 1)
    degree.set(b, (degree.get(b) ?? 0) + 1)
  }

  for (const [id, deg] of Array.from(degree.entries())) {
    const visible = snapshot.visibleByMember.get(id)
    if (visible === undefined) { bump('member_missing_from_capacity_snapshot'); continue }
    const deficit = visibleDeficit(visible, snapshot.maxVisible)
    if (deficit === 0) bump('member_already_full')
    if (deg > deficit) bump('member_degree_exceeds_deficit')
    if (visible + deg > snapshot.maxVisible) bump('projected_visible_exceeds_max')
  }

  // Symmetric expansion must be exactly 2 rows per pair, one per direction.
  if (directionalRows.length !== seenPairs.size * 2) bump('directional_rows_mismatch')
  const dir = new Set(directionalRows.map((r) => `${r.recipient_id}>${r.suggested_id}`))
  for (const r of directionalRows) {
    if (!dir.has(`${r.suggested_id}>${r.recipient_id}`)) { bump('asymmetric_proposal_rows'); break }
  }

  return { ok: Object.keys(v).length === 0, violations: v }
}
