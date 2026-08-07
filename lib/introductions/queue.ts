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
 * batch, and never more than RECOMMENDATIONS_PER_BATCH visible recommendations.
 * Two partial-unique indexes enforce the ≤1 active / ≤1 queued limits at the database
 * level; this module enforces placement, admin precedence, promotion, and generation
 * eligibility on top of that.
 *
 * Generation (creating a new batch) and promotion (revealing an already-generated
 * queued batch) are deliberately different operations — see enqueueBatch vs
 * promoteIfResolved. Promotion never generates and never consumes inventory.
 */
import { randomUUID } from 'node:crypto'
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
  state?: 'active' | 'queued'
  batchId?: string
  count?: number
  /** Why nothing was placed: 'empty' | 'all_duplicates' | 'queued_admin_exists' | 'queued_slot_full' */
  reason?: string
  /** When an organic queued batch was displaced by an admin batch, its id. */
  discardedQueued?: string
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

/** Remove rows whose target already occupies a slot for this member (dedupe). */
async function dedupeRows(adminClient: any, memberId: string, rows: QueueRow[]): Promise<QueueRow[]> {
  const targets = rows.map((r) => r.target_user_id)
  if (targets.length === 0) return []
  const { data: existing } = await adminClient
    .from('intro_requests').select('target_user_id, status')
    .eq('requester_id', memberId)
    .in('status', OCCUPYING_STATUSES as unknown as string[])
    .in('target_user_id', targets)
  const taken = new Set((existing ?? []).map((r: any) => r.target_user_id))
  // Also dedupe within the incoming rows themselves.
  const seen = new Set<string>()
  return rows.filter((r) => {
    if (taken.has(r.target_user_id) || seen.has(r.target_user_id)) return false
    seen.add(r.target_user_id)
    return true
  })
}

/** Create a recommendation_batches row + its intro_requests rows in the given state. */
async function insertBatch(
  adminClient: any,
  memberId: string,
  source: BatchSource,
  rows: QueueRow[],
  rowStatus: 'suggested' | 'queued',
  reciprocalBatchId: string | null,
): Promise<string> {
  const batchId = randomUUID()
  const now = new Date().toISOString()
  const { error: batchErr } = await adminClient.from('recommendation_batches').insert({
    batch_id: batchId,
    member_id: memberId,
    batch_source: source,
    state: rowStatus === 'suggested' ? 'active' : 'queued',
    reciprocal_batch_id: reciprocalBatchId,
    created_at: now,
    generated_at: now,
    displayed_at: rowStatus === 'suggested' ? now : null,
    completed_at: null,
  })
  if (batchErr) throw new Error(`recommendation_batches insert failed: ${batchErr.message}`)

  const introRows = rows.map((r) => ({
    requester_id: memberId,
    target_user_id: r.target_user_id,
    status: rowStatus,
    match_reason: r.match_reason ?? null,
    batch_id: batchId,
    created_at: now,
    updated_at: now,
  }))
  const { error: rowsErr } = await adminClient.from('intro_requests').insert(introRows)
  if (rowsErr) {
    // Compensating cleanup so a failed insert never leaves an empty batch row.
    await adminClient.from('recommendation_batches').delete().eq('batch_id', batchId)
    throw new Error(`intro_requests insert failed: ${rowsErr.message}`)
  }
  return batchId
}

/** Discard an organic queued batch: delete its recommendation rows, keep metadata. */
async function discardQueuedBatch(adminClient: any, batch: RecommendationBatch): Promise<void> {
  await adminClient.from('intro_requests').delete()
    .eq('requester_id', batch.member_id).eq('batch_id', batch.batch_id).eq('status', 'queued')
  await adminClient.from('recommendation_batches')
    .update({ state: 'discarded' }).eq('batch_id', batch.batch_id)
}

// ── Enqueue (generation placement + admin precedence) ─────────────────────────

/**
 * Place a freshly produced batch into the member's queue. Placement is the single
 * choke-point that upholds the active window:
 *
 *   • active slot empty                        → becomes ACTIVE (visible)
 *   • active occupied, queued empty            → becomes QUEUED (hidden)
 *   • active occupied, queued has ORGANIC batch → admin source DISCARDS the organic
 *       queued batch (rows deleted, metadata kept) and takes the queued slot;
 *       an organic source is refused (weekly eligibility should prevent this)
 *   • active occupied, queued has ADMIN batch  → admin source is REJECTED (no stacking)
 *
 * Rows whose target already occupies a slot are deduped away first.
 */
export async function enqueueBatch(
  adminClient: any,
  opts: { memberId: string; source: BatchSource; rows: QueueRow[]; reciprocalBatchId?: string | null },
): Promise<EnqueueResult> {
  const { memberId, source } = opts
  const reciprocalBatchId = opts.reciprocalBatchId ?? null

  const rows = await dedupeRows(adminClient, memberId, opts.rows)
  if (opts.rows.length === 0) return { placed: false, reason: 'empty' }
  if (rows.length === 0) return { placed: false, reason: 'all_duplicates' }

  const active = await getActiveBatch(adminClient, memberId)
  if (!active) {
    const batchId = await insertBatch(adminClient, memberId, source, rows, 'suggested', reciprocalBatchId)
    return { placed: true, state: 'active', batchId, count: rows.length }
  }

  const queued = await getQueuedBatch(adminClient, memberId)
  if (!queued) {
    const batchId = await insertBatch(adminClient, memberId, source, rows, 'queued', reciprocalBatchId)
    return { placed: true, state: 'queued', batchId, count: rows.length }
  }

  // Queued slot occupied. Only an admin batch may claim it.
  if (source !== 'admin_reciprocal') {
    return { placed: false, reason: 'queued_slot_full' }
  }
  if (queued.batch_source === 'admin_reciprocal') {
    return { placed: false, reason: 'queued_admin_exists' }
  }
  // Admin precedence: discard the organic queued batch and take the slot. The
  // discarded organic recommendations regenerate fresh at the member's next
  // weekly eligibility — never archived, never resurfaced.
  await discardQueuedBatch(adminClient, queued)
  const batchId = await insertBatch(adminClient, memberId, source, rows, 'queued', reciprocalBatchId)
  return { placed: true, state: 'queued', batchId, count: rows.length, discardedQueued: queued.batch_id }
}

// ── Promotion (reveal an already-generated queued batch) ──────────────────────

/**
 * Called immediately after a member resolves a recommendation (pass or express
 * interest). If the active batch is now fully resolved, complete it and — if a
 * queued batch is waiting — promote that queued batch to ACTIVE (reveal only, no
 * generation). If nothing is queued, the member simply has no active batch until the
 * next producer fills it. Idempotent and safe to call on every resolving action.
 */
export async function promoteIfResolved(adminClient: any, memberId: string): Promise<PromoteResult> {
  const active = await getActiveBatch(adminClient, memberId)
  if (!active) return { promoted: false, reason: 'no_active' }

  const unresolved = await countUnresolvedRecommendations(adminClient, memberId)
  if (unresolved > 0) return { promoted: false, reason: 'incomplete' }

  const now = new Date().toISOString()
  // Complete the active batch: archive any lingering 'suggested' rows (those resolved
  // by expressed interest — the interest itself lives on its own pending/approved row,
  // so archiving here never hides a Pending card) and stamp completed_at.
  await adminClient.from('intro_requests')
    .update({ status: 'archived', updated_at: now })
    .eq('requester_id', memberId).eq('batch_id', active.batch_id).eq('status', 'suggested')
  await adminClient.from('recommendation_batches')
    .update({ state: 'completed', completed_at: now }).eq('batch_id', active.batch_id)

  const queued = await getQueuedBatch(adminClient, memberId)
  if (!queued) return { promoted: false, activeCompleted: active.batch_id, reason: 'empty_queue' }

  // Reveal the queued batch: flip its rows to visible and mark the batch active.
  await adminClient.from('intro_requests')
    .update({ status: 'suggested', updated_at: now })
    .eq('requester_id', memberId).eq('batch_id', queued.batch_id).eq('status', 'queued')
  await adminClient.from('recommendation_batches')
    .update({ state: 'active', displayed_at: now }).eq('batch_id', queued.batch_id)

  return { promoted: true, activeCompleted: active.batch_id, newActive: queued.batch_id }
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
