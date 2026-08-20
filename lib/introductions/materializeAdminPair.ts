/**
 * Typed client for public.materialize_admin_pair (migration 064).
 *
 * ONE reviewed undirected admin pair -> two directional intro_requests rows sharing one pair_id,
 * both in the same tier, or nothing at all. This replaces the per-recipient place_batch_rows calls
 * that admin approval used to make, which inserted one direction each and — because the RPC's
 * eligibility gate is bidirectional — caused the second side of every edge to be filtered out.
 * The production audit measured the result: 145 live one-sided rows, all with pair_id IS NULL.
 *
 * The RPC is the AUTHORITY on capacity and eligibility. Generation happens minutes-to-days before
 * approval, so a member's cards can change in between; a `capacity` or gate outcome here is a
 * normal, expected answer and not an error.
 */

/** Every outcome the RPC can return. Anything else is treated as a transient error. */
export type MaterializeOutcome =
  | 'created'                // both rows written, one pair_id, one shared tier
  | 'already_materialized'   // this exact approval already succeeded; nothing written
  | 'exists_active'          // a live/committed intro already links these two
  | 'capacity'               // no tier had room for BOTH members
  | 'ineligible'
  | 'blocked'
  | 'same_company'
  | 'already_matched'
  | 'history'
  | 'cooldown'
  | 'invalid'
  | 'error'                  // client-side only: transport/timeout

export interface MaterializeResult {
  outcome: MaterializeOutcome
  tier?: 'suggested' | 'queued' | null
  pairId?: string | null
  batchIdLo?: string | null
  batchIdHi?: string | null
  /** Coarse reason for 'invalid'; never contains an identity or a raw database message. */
  detail?: string | null
}

/** Outcomes that mean the pair is settled and must NOT be retried in this cycle. */
export const TERMINAL_OUTCOMES: ReadonlySet<MaterializeOutcome> = new Set<MaterializeOutcome>([
  'created', 'already_materialized', 'exists_active', 'ineligible', 'blocked',
  'same_company', 'already_matched', 'history', 'cooldown', 'invalid',
])

/** True when the pair did NOT land and its review rows are still approvable later. */
export function isDeferrable(o: MaterializeOutcome): boolean {
  return o === 'capacity' || o === 'error'
}

/**
 * CANONICAL APPROVAL ORDER.
 *
 * Approval is one RPC call per edge, and each call rechecks capacity, so ITERATION ORDER DECIDES
 * which pairs materialise when capacity is scarce. Left to chance — database return order, object
 * insertion order, or UI order — the outcome would be arbitrary and irreproducible, and it would
 * silently contradict the optimizer's priorities.
 *
 * This reproduces the optimizer's lexicographic order at approval time, using only facts available
 * then (live card counts and the reviewed scores):
 *   1. pairs serving more ZERO-card members first
 *   2. then pairs serving more underfilled members
 *   3. then greater total remaining deficit across the two endpoints
 *   4. then higher adjusted quality (the reviewed score sum)
 *   5. then the canonical pair key — total, so the order is a strict, reproducible sequence
 *
 * Every comparison is on a value computed BEFORE the loop starts, so the order is fixed up front
 * and a retry produces the identical sequence. Already-materialised pairs are skipped safely by the
 * RPC's own replay path, so a retry converges without re-deriving anything.
 */
export function canonicalApprovalOrder(
  pairs: Array<{ a: string; b: string }>,
  ctx: {
    visibleCardsOf: (memberId: string) => number
    capacity?: number
    scoreOf?: (a: string, b: string) => number
  },
): Array<{ a: string; b: string }> {
  const cap = ctx.capacity ?? 2
  const score = ctx.scoreOf ?? (() => 0)
  const key = (p: { a: string; b: string }) => (p.a < p.b ? `${p.a}|${p.b}` : `${p.b}|${p.a}`)
  const rank = (p: { a: string; b: string }) => {
    const va = ctx.visibleCardsOf(p.a), vb = ctx.visibleCardsOf(p.b)
    const zero = (va === 0 ? 1 : 0) + (vb === 0 ? 1 : 0)
    const under = (va < cap ? 1 : 0) + (vb < cap ? 1 : 0)
    const deficit = Math.max(0, cap - va) + Math.max(0, cap - vb)
    return { zero, under, deficit, quality: score(p.a, p.b) }
  }
  return pairs
    .map((p) => ({ p, r: rank(p), k: key(p) }))
    .sort((x, y) =>
      y.r.zero - x.r.zero ||
      y.r.under - x.r.under ||
      y.r.deficit - x.r.deficit ||
      y.r.quality - x.r.quality ||
      x.k.localeCompare(y.k))
    .map((e) => e.p)
}

export async function materializeAdminPair(
  admin: any,
  opts: { reviewBatchId: string; memberA: string; memberB: string; cooldownDays?: number },
): Promise<MaterializeResult> {
  const { reviewBatchId, memberA, memberB } = opts
  if (!reviewBatchId || !memberA || !memberB || memberA === memberB) {
    return { outcome: 'invalid', detail: 'client_precheck' }
  }
  const { data, error } = await admin.rpc('materialize_admin_pair', {
    p_review_batch_id: reviewBatchId,
    p_member_a: memberA,
    p_member_b: memberB,
    // batch ids are derived inside the RPC; passing them from here would be a provenance
    // surface with nothing to gain, since the caller cannot know them before the first call.
    p_batch_a: null,
    p_batch_b: null,
    p_cooldown_days: opts.cooldownDays ?? 30,
  })
  if (error) {
    // CLASS only — never a member id, a target id, or a raw database message. A retry is safe:
    // the RPC takes both participant advisory locks and re-reads live state, so a call that
    // actually committed before the timeout returns 'already_materialized' on the retry.
    console.error('[materialize-admin-pair] rpc failed (class):', error.code ?? 'unknown')
    return { outcome: 'error' }
  }
  const r = (data ?? {}) as Record<string, any>
  const outcome = (r.outcome as MaterializeOutcome) ?? 'error'
  return {
    outcome,
    tier: r.tier ?? null,
    pairId: r.pair_id ?? null,
    batchIdLo: r.batch_id_lo ?? null,
    batchIdHi: r.batch_id_hi ?? null,
    detail: r.detail ?? null,
  }
}

/**
 * Collapse a batch's symmetric review rows into UNDIRECTED pairs, so approval calls the RPC once
 * per pair rather than once per recipient. Deterministic: canonical id order, then sorted.
 * A row whose mirror is missing is returned separately — it is exactly the one-sided shape that
 * must never be materialised.
 */
export function toUndirectedPairs(
  rows: Array<{ recipient_id: string | null; suggested_id: string | null }>,
): { pairs: Array<{ a: string; b: string }>; unpaired: number } {
  const seen = new Set<string>()
  const both = new Set<string>()
  for (const r of rows) {
    if (!r?.recipient_id || !r?.suggested_id || r.recipient_id === r.suggested_id) continue
    seen.add(`${r.recipient_id}>${r.suggested_id}`)
  }
  for (const k of Array.from(seen)) {
    const [x, y] = k.split('>')
    if (seen.has(`${y}>${x}`)) both.add(x < y ? `${x}|${y}` : `${y}|${x}`)
  }
  const pairs = Array.from(both).sort().map((k) => {
    const [a, b] = k.split('|'); return { a, b }
  })
  return { pairs, unpaired: seen.size - both.size * 2 }
}
