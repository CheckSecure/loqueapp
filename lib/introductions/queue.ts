/**
 * THE unified recommendation queue service.
 *
 * intro_requests is the single member-facing recommendation store. Every producer
 * — onboarding, the weekly engine, admin reciprocal send, and any future producer —
 * enqueues THROUGH this module; nothing writes recommendation rows directly. The
 * recommendation_batches table (migration 020) is the invariant anchor:
 *
 *   • ACTIVE   batch → visible; its intro_requests rows are status 'suggested'
 *   • QUEUED   batch → hidden, waiting; its intro_requests rows are status 'queued'
 *   • COMPLETED/DISCARDED → resolved / displaced (kept for analytics)
 *
 * Guaranteed at all times, per member: exactly one ACTIVE batch, at most one QUEUED
 * batch, at most MAX_VISIBLE_INTRO_CARDS cards with status 'suggested', and — as a
 * SEPARATE tier — at most MAX_RESERVED_INTRO_CARDS with status 'queued'. The two card
 * caps are independent: a reservation nobody has seen does not consume a visible slot.
 * See lib/introductions/capacity for the contract.
 *
 * WHERE EACH INVARIANT IS ENFORCED. Two partial-unique indexes enforce ≤1 active / ≤1
 * queued batch. The CARD caps are enforced in the database, by place_batch_rows,
 * promote_queued_rows and create_reciprocal_suggestion (migration 063), each holding
 * pg_advisory_xact_lock(hashtextextended(member_id)) while it counts and writes. This
 * module is now a typed client for those RPCs plus the read-only eligibility helpers —
 * it deliberately no longer writes recommendation rows itself, because a capacity
 * decision split across several round trips from Node cannot be made race-safe, and
 * the UI's 2-card slice hides an over-capacity member rather than preventing one.
 *
 * Generation (creating a new batch) and promotion (revealing an already-generated
 * queued batch) are deliberately different operations — see enqueueBatch vs
 * promoteIfResolved. Promotion never generates and never consumes inventory.
 */
import { RECOMMENDATIONS_PER_BATCH } from '@/lib/introductions/limits'

export type BatchSource = 'onboarding' | 'weekly' | 'admin_reciprocal' | 'migration'
export type BatchState = 'active' | 'queued' | 'completed' | 'discarded'

export interface QueueRow {
  target_user_id: string
  match_reason?: string | null
}

export interface RecommendationBatch {
  batch_id: string
  member_id: string
  batch_source: BatchSource
  state: BatchState
  reciprocal_batch_id: string | null
  created_at: string
  generated_at: string
  displayed_at: string | null
  completed_at: string | null
}

export interface EnqueueResult {
  placed: boolean
  /** Cards written into the VISIBLE tier (status 'suggested') by this call. */
  visiblePlaced: number
  /** Cards written into the RESERVED tier (status 'queued') by this call. */
  reservedPlaced: number
  /** Supplied rows that landed nowhere — beyond BOTH caps, or filtered by an eligibility gate. */
  dropped: number
  /** The active batch the visible rows joined or created, when any. */
  activeBatchId?: string | null
  /** The queued batch the reserved rows joined or created, when any. */
  queuedBatchId?: string | null
  /**
   * Why nothing was placed:
   *   'empty' | 'invalid' | 'ineligible' | 'too_many_rows' | 'no_eligible_candidates'
   *   | 'at_capacity'   (both tiers full)
   *   | 'reserved_full' (visible full, reserved full)
   *   | 'source_mismatch' (the only free tier holds a batch from a different producer; appending
   *                        would make batch_source a lie, so the call refuses rather than merge)
   *   | 'inconsistent_batches'
   */
  reason?: string
}

export interface PromoteResult {
  promoted: boolean
  activeCompleted?: string
  newActive?: string
  reason?: string
}

/**
 * Statuses that mean the member has EXPRESSED INTEREST in a recommendation (which
 * resolves the underlying 'suggested' row for completion, even while still pending).
 * createIntroRequest inserts one of these and LEAVES the 'suggested' row in place,
 * so completion is measured by cross-referencing the target, not by row deletion.
 */
export const EXPRESSED_INTEREST_STATUSES = ['pending', 'accepted', 'accepted_pending_payment', 'admin_pending', 'approved'] as const

/** Statuses that occupy a member's target (they should not be re-suggested).
 *  `accepted_pending_payment` is included so a mid-payment pair is never re-enqueued. */
const OCCUPYING_STATUSES = ['suggested', 'queued', 'pending', 'accepted', 'accepted_pending_payment', 'admin_pending', 'approved'] as const

// ── Slot reads ──────────────────────────────────────────────────────────────

export async function getActiveBatch(adminClient: any, memberId: string): Promise<RecommendationBatch | null> {
  const { data } = await adminClient
    .from('recommendation_batches')
    .select('*')
    .eq('member_id', memberId)
    .eq('state', 'active')
    .maybeSingle()
  return (data as RecommendationBatch) ?? null
}

export async function getQueuedBatch(adminClient: any, memberId: string): Promise<RecommendationBatch | null> {
  const { data } = await adminClient
    .from('recommendation_batches')
    .select('*')
    .eq('member_id', memberId)
    .eq('state', 'queued')
    .maybeSingle()
  return (data as RecommendationBatch) ?? null
}

/**
 * Count a member's still-UNRESOLVED recommendations. A 'suggested' row is resolved
 * when the member has acted on it — passed/hidden (the row leaves 'suggested') or
 * expressed interest (an outbound pending/approved request to that target exists).
 * Only the ACTIVE batch ever holds 'suggested' rows, so this equals the active
 * batch's open count. Returns 0 when the active batch is complete (or none exists).
 */
export async function countUnresolvedRecommendations(adminClient: any, memberId: string): Promise<number> {
  const { data: suggested } = await adminClient
    .from('intro_requests').select('target_user_id')
    .eq('requester_id', memberId).eq('status', 'suggested')
  const targets: string[] = (suggested ?? []).map((r: any) => r.target_user_id)
  if (targets.length === 0) return 0
  const { data: expressed } = await adminClient
    .from('intro_requests').select('target_user_id')
    .eq('requester_id', memberId)
    .in('status', EXPRESSED_INTEREST_STATUSES as unknown as string[])
    .in('target_user_id', targets)
  const expressedSet = new Set((expressed ?? []).map((r: any) => r.target_user_id))
  return targets.filter((t) => !expressedSet.has(t)).length
}

/**
 * PURE, pool-wide analogue of countUnresolvedRecommendations. Given a full set of
 * intro_requests rows, return the set of member ids that have ≥1 UNRESOLVED active
 * recommendation — a 'suggested' row whose requester has NOT expressed interest in
 * that target. Uses the SAME "resolved" definition as countUnresolvedRecommendations
 * (EXPRESSED_INTEREST_STATUSES), so one in-memory pass replaces a per-member query.
 * Read-only: computes a set, changes no queue state.
 */
export function membersWithUnresolvedIntros(
  rows: Array<{ requester_id?: string | null; target_user_id?: string | null; status?: string | null }> | null | undefined,
): Set<string> {
  const suggested = new Map<string, Set<string>>() // requester → targets with a live 'suggested' row
  const expressed = new Map<string, Set<string>>() // requester → targets they expressed interest in
  const push = (m: Map<string, Set<string>>, k: string, v: string) => {
    let s = m.get(k)
    if (!s) { s = new Set<string>(); m.set(k, s) }
    s.add(v)
  }
  const EXPRESSED = new Set<string>(EXPRESSED_INTEREST_STATUSES as unknown as string[])
  for (const r of rows ?? []) {
    if (!r?.requester_id || !r?.target_user_id) continue
    if (r.status === 'suggested') push(suggested, r.requester_id, r.target_user_id)
    else if (r.status && EXPRESSED.has(r.status)) push(expressed, r.requester_id, r.target_user_id)
  }
  const unresolved = new Set<string>()
  for (const [member, targets] of Array.from(suggested.entries())) {
    const exp = expressed.get(member)
    for (const t of Array.from(targets)) {
      if (!exp || !exp.has(t)) { unresolved.add(member); break } // an unmet suggestion → unresolved
    }
  }
  return unresolved
}

// ── Internal helpers ─────────────────────────────────────────────────────────
//
// dedupeRows / insertBatch / discardQueuedBatch have been REMOVED, not merely bypassed. They were an
// unlocked, multi-round-trip way to write recommendation rows, and leaving them importable would
// leave the defect one call site away. Their logic now lives inside public.place_batch_rows, where
// it runs under the member advisory lock in a single transaction.

// ── Enqueue (generation placement + admin precedence) ─────────────────────────

/**
 * Place a freshly produced batch into the member's queue.
 *
 * DELEGATES TO public.place_batch_rows (migration 063). Placement is a CAPACITY DECISION, and a
 * capacity decision taken across several round trips from Node cannot be made safe: this function
 * previously read the batch slots and then inserted, so two producers for the same member — the
 * weekly cron and an admin send, or two retries of the same onboarding — could both observe an empty
 * slot and both fill it. Worse, it inferred occupancy from the EXISTENCE of a recommendation_batches
 * row, so a member holding only reciprocal cards (batch_id NULL by design) looked empty and received
 * two more visible cards on top of them.
 *
 * The RPC does the whole decision in ONE transaction while holding
 * pg_advisory_xact_lock(hashtextextended(member_id)) — the same lock create_reciprocal_suggestion
 * takes — so reciprocal creation and batch placement for one member serialize against each other.
 * It counts intro_requests by STATUS (visible = 'suggested', reserved = 'queued'), fills only free
 * slots, and TRUNCATES the surplus instead of overflowing.
 *
 * ONE CALL USES ALL SAFELY AVAILABLE CAPACITY, in tier order:
 *   1. fill free VISIBLE slots   (status 'suggested', max 2)
 *   2. fill free RESERVED slots  (status 'queued',    max 2) with what is left
 *   3. drop only what exceeds BOTH
 * So a member holding 1 visible and 0 reserved, offered 2 candidates, ends with 1 new visible AND
 * 1 new reserved — not 1 placed and 1 thrown away. Both writes happen in the same transaction under
 * the same lock. The batch a row joins is the member's existing active/queued batch, or a new one
 * when none exists; a second batch of either state is never created, so the partial-unique indexes
 * are untouched. Appending is refused when the existing batch's source differs ('source_mismatch'),
 * because merging would make batch_source a lie.
 *
 * NOTHING IS EVER EVICTED. There is no delete and no discard anywhere in this path, for any source.
 * An admin batch has no precedence over capacity: at capacity the call refuses and every existing
 * row and batch is left untouched. (The previous implementation deleted an organic queued batch to
 * make room for an admin one. That behaviour is gone.)
 *
 * ELIGIBILITY IS RE-CHECKED IN THE RPC. A service-role caller is not trusted to supply safe targets:
 * each candidate must independently pass member/target eligibility, block, match, live-intro and
 * cooldown gates. `dropped` therefore counts both over-capacity rows and rows a gate rejected.
 */
export async function enqueueBatch(
  adminClient: any,
  opts: { memberId: string; source: BatchSource; rows: QueueRow[]; reciprocalBatchId?: string | null },
): Promise<EnqueueResult> {
  const { memberId, source } = opts
  const none = { visiblePlaced: 0, reservedPlaced: 0, dropped: 0 }
  // Fail closed on a malformed call rather than throwing on `.map`. The RPC validates everything
  // again server-side; this only avoids a crash before the round trip and keeps the refusal shape
  // consistent with the one the RPC would have returned.
  if (!memberId || typeof memberId !== 'string') return { placed: false, ...none, reason: 'invalid' }
  if (!Array.isArray(opts.rows)) return { placed: false, ...none, reason: 'invalid' }
  if (opts.rows.length === 0) return { placed: false, ...none, reason: 'empty' }

  const { data, error } = await adminClient.rpc('place_batch_rows', {
    p_member_id: memberId,
    p_source: source,
    // Order is significant: it is the ranker's order, and the RPC fills the visible tier from the
    // front, then the reserved tier, then drops the rest.
    p_rows: opts.rows.map((r) => ({ target_user_id: r.target_user_id, match_reason: r.match_reason ?? null })),
    p_reciprocal_batch_id: opts.reciprocalBatchId ?? null,
    // No cap argument exists. The limits are constants inside the function, so no caller — this one
    // included — can raise them. lib/introductions/capacity carries the same numbers for the
    // application's own reasoning, and a test asserts the two definitions agree.
  })
  if (error) {
    // Placement is a write: it must NOT fail open into a second, unlocked code path, because that is
    // exactly how the over-capacity rows were created. Throw so the caller's existing error handling
    // records a failed generation and the member simply keeps what they already have. The message
    // carries the error CLASS only — never a member id, a target id or a raw database message.
    throw new Error(`place_batch_rows failed (${error.code ?? 'unknown'})`)
  }
  const r = (data ?? {}) as Record<string, any>
  return {
    placed: Boolean(r.placed),
    visiblePlaced: Number(r.visible_placed ?? 0),
    reservedPlaced: Number(r.reserved_placed ?? 0),
    dropped: Number(r.dropped ?? 0),
    activeBatchId: r.active_batch_id ?? null,
    queuedBatchId: r.queued_batch_id ?? null,
    ...(r.reason ? { reason: r.reason } : {}),
  }
}

// ── Promotion (reveal an already-generated queued batch) ──────────────────────

/**
 * Called immediately after a member resolves a recommendation (pass or express interest). If the
 * active batch is now fully resolved, complete it and reveal a waiting queued batch.
 *
 * DELEGATES TO public.promote_queued_rows (migration 063), for the same reason placement does: this
 * was a read-then-write sequence with no lock, and it revealed the ENTIRE queued batch without
 * re-checking how many visible slots were actually free. A member who had expressed interest in
 * their two batch cards while still holding a live reciprocal card (batch_id NULL — pair-governed,
 * so the batch-scoped archive deliberately leaves it alone) went straight to three visible cards,
 * of which the UI silently showed two.
 *
 * The RPC re-counts visible cards AFTER completing the active batch, reveals only what fits
 * oldest-first, and splits any remainder into a fresh queued batch so every batch's rows still match
 * its state. When nothing fits it defers ('deferred_capacity') without discarding anything, and
 * because it no longer requires an active batch to exist, the next resolving action promotes the
 * deferred reservation. Idempotent and safe to call on every resolving action.
 */
export async function promoteIfResolved(adminClient: any, memberId: string): Promise<PromoteResult> {
  const { data, error } = await adminClient.rpc('promote_queued_rows', { p_member_id: memberId })
  if (error) {
    // Every caller already treats a promotion failure as non-fatal and logs it; surface the error
    // class only (no member identifiers, no raw message) and report "not promoted".
    console.error('[queue] promote_queued_rows failed (class):', error.code ?? 'unknown')
    return { promoted: false, reason: 'error' }
  }
  const r = (data ?? {}) as Record<string, any>
  return {
    promoted: Boolean(r.promoted),
    ...(r.active_completed ? { activeCompleted: r.active_completed } : {}),
    ...(r.new_active ? { newActive: r.new_active } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
  }
}

// ── Weekly generation eligibility ─────────────────────────────────────────────

export type WeeklyEligibilityReason = 'eligible' | 'unresolved_active' | 'behind_admin' | 'queued_exists'

export interface WeeklyEligibility {
  eligible: boolean
  reason: WeeklyEligibilityReason
  /** Unresolved/actionable introductions from the member's active batch (see countUnresolvedRecommendations). */
  unresolvedCount: number
  /** The member's active batch id (when any) — used for reminder de-duplication. */
  activeBatchId: string | null
}

/**
 * Whether the weekly engine may GENERATE a new batch for this member right now, with
 * the REASON when it may not.
 *
 * PERMANENT RULE (retires the queued-organic path): a member is ineligible for the
 * weekly refresh if they have EVEN ONE unresolved/actionable introduction from an
 * active batch — organic OR admin. "Unresolved" is exactly countUnresolvedRecommendations:
 * a 'suggested' row whose requester has NOT expressed interest (pending / accepted /
 * accepted_pending_payment / admin_pending / approved) in that target; passed/hidden
 * rows have already left 'suggested' and never count. Once the member acts on all of
 * them, the active batch completes (promoteIfResolved) and they become eligible at the
 * next scheduled run — no immediate catch-up is generated here.
 *
 * Admin reciprocal batches are unchanged: a member behind an incomplete admin batch is
 * still skipped (now reported as `behind_admin`), and admin generation is untouched.
 *
 * (The caller has already confirmed the member is active + profile_complete.)
 */
export async function evaluateWeeklyEligibility(adminClient: any, memberId: string): Promise<WeeklyEligibility> {
  const unresolved = await countUnresolvedRecommendations(adminClient, memberId)
  if (unresolved > 0) {
    const active = await getActiveBatch(adminClient, memberId)
    const reason: WeeklyEligibilityReason = active?.batch_source === 'admin_reciprocal' ? 'behind_admin' : 'unresolved_active'
    return { eligible: false, reason, unresolvedCount: unresolved, activeBatchId: active?.batch_id ?? null }
  }
  // No unresolved active work. A lingering queued batch (rare now the queued-organic
  // path is retired) still blocks generation to preserve the ≤1 active / ≤1 queued invariant.
  const queued = await getQueuedBatch(adminClient, memberId)
  if (queued) return { eligible: false, reason: 'queued_exists', unresolvedCount: 0, activeBatchId: null }
  return { eligible: true, reason: 'eligible', unresolvedCount: 0, activeBatchId: null }
}

/** Backward-compatible boolean gate (delegates to evaluateWeeklyEligibility). */
export async function weeklyEligibilityCheck(adminClient: any, memberId: string): Promise<boolean> {
  return (await evaluateWeeklyEligibility(adminClient, memberId)).eligible
}

export { RECOMMENDATIONS_PER_BATCH }
