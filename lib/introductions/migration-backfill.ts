/**
 * Unified Recommendation Queue — one-time migration of existing members onto the
 * active-window model. Two entry points:
 *
 *   • buildBackfillReport(adminClient)  — READ-ONLY. Produces the JSON dry-run
 *     report (member counts, visible-recommendation distribution, how many recs
 *     would be discarded, how many admin batches would materialize). Mutates nothing.
 *
 *   • applyBackfill(adminClient)        — WRITES. Collapses each member to Current
 *     (≤ N active) + Next (≤ N queued) and DISCARDS everything beyond (deleted, not
 *     archived). HELD: never invoked automatically; runs only after explicit operator
 *     approval of the report and the schema migration.
 *
 * "Visible" today = a member's live recommendations (intro_requests status
 * 'suggested') plus any SENT admin reciprocal suggestions (batch_suggestions status
 * 'shown'), deduped by target — exactly the set the pre-migration UI could show.
 *
 * applyBackfill preserves existing rows (it UPDATEs status/batch_id in place, keeping
 * match_reason and created_at) rather than delete-and-reinsert, so no recommendation
 * content is lost. It is idempotent and resume-safe: a member is skipped once it has
 * an ACTIVE recommendation_batches row, and each unmigrated member is first reset to a
 * clean pre-migration state (partial queued flips reverted, partial batch metadata
 * cleared) so a re-run after an interruption never double-creates or strands a row.
 * The only deletes are genuine excess beyond Current+Next.
 */
import { randomUUID } from 'node:crypto'
import { RECOMMENDATIONS_PER_BATCH } from '@/lib/introductions/limits'
import { calculateAlignmentScore, applyLawFirmCompositionPolicy } from '@/lib/generate-recommendations'

// Profile fields needed to deterministically re-rank a member's existing suggested
// candidates (viewer + candidate) and to apply the law-firm composition policy.
const RANK_PROFILE_COLS = 'id, role_type, seniority, expertise, intro_preferences, city, state'

/** match_reason signal strength = number of reason bullets (higher = stronger). */
function signalStrength(reason: string | null | undefined): number {
  return typeof reason === 'string' ? reason.split('\n').map((l) => l.trim()).filter(Boolean).length : 0
}

const N = RECOMMENDATIONS_PER_BATCH
const KEEP = 2 * N // Current (N) + Next (N)

export interface BackfillReport {
  batchSize: number
  totalMembers: number
  usersSeeingMoreThanBatchSize: number
  visibleDistribution: { '0': number; '1': number; '2': number; '3': number; '4plus': number }
  recommendationsToDiscard: number
  adminSuggestionBatchesToMaterialize: number
  generatedAtNote: string
}

async function pageAll(adminClient: any, table: string, cols: string, filter: (q: any) => any): Promise<any[]> {
  const out: any[] = []
  let from = 0
  const size = 1000
  for (;;) {
    const { data, error } = await filter(adminClient.from(table).select(cols)).range(from, from + size - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...(data ?? []))
    if (!data || data.length < size) break
    from += size
  }
  return out
}

async function activeMemberIds(adminClient: any): Promise<Set<string>> {
  const rows = await pageAll(adminClient, 'profiles', 'id', (q) =>
    q.eq('account_status', 'active').eq('profile_complete', true).not('is_test_account', 'is', true))
  return new Set(rows.map((r) => r.id))
}

export async function buildBackfillReport(adminClient: any): Promise<BackfillReport> {
  const memberSet = await activeMemberIds(adminClient)
  const suggested = await pageAll(adminClient, 'intro_requests', 'requester_id, target_user_id', (q) => q.eq('status', 'suggested'))
  const shown = await pageAll(adminClient, 'batch_suggestions', 'recipient_id, suggested_id, batch_id', (q) => q.eq('status', 'shown'))

  const visible = new Map<string, Set<string>>()
  const adminBatchIds = new Set<string>()
  const add = (member: string, target: string) => {
    if (!memberSet.has(member)) return
    if (!visible.has(member)) visible.set(member, new Set())
    visible.get(member)!.add(target)
  }
  for (const r of suggested) add(r.requester_id, r.target_user_id)
  for (const r of shown) { add(r.recipient_id, r.suggested_id); if (memberSet.has(r.recipient_id) && r.batch_id) adminBatchIds.add(r.batch_id) }

  const dist = { '0': 0, '1': 0, '2': 0, '3': 0, '4plus': 0 }
  let usersOver = 0
  let toDiscard = 0
  for (const id of Array.from(memberSet)) {
    const v = visible.get(id)?.size ?? 0
    if (v >= 4) dist['4plus']++
    else (dist as any)[String(v)]++
    if (v > N) usersOver++
    if (v > KEEP) toDiscard += v - KEEP
  }

  return {
    batchSize: N,
    totalMembers: memberSet.size,
    usersSeeingMoreThanBatchSize: usersOver,
    visibleDistribution: dist,
    recommendationsToDiscard: toDiscard,
    adminSuggestionBatchesToMaterialize: adminBatchIds.size,
    generatedAtNote: 'Timestamp stamped by the caller (scripts cannot call Date.now()).',
  }
}

export interface BackfillApplyResult {
  membersProcessed: number
  membersSkipped: number
  activeBatchesCreated: number
  queuedBatchesCreated: number
  recommendationsDiscarded: number
}

interface QueueItem { rowId?: string; target: string; reason: string | null }

interface ApplyInputs {
  memberSet: Set<string>
  irByMember: Map<string, any[]>
  adminByMember: Map<string, { target: string; reason: string | null }[]>
  profileMap: Map<string, any>
}

/** READ-ONLY collection shared by planBackfill (dry) and applyBackfill (write). */
async function collectForApply(adminClient: any): Promise<ApplyInputs> {
  const memberSet = await activeMemberIds(adminClient)
  // Existing queue-candidate rows (suggested OR a partial 'queued' from a prior
  // interrupted run) + sent admin suggestions, grouped per member.
  const irRows = await pageAll(adminClient, 'intro_requests', 'id, requester_id, target_user_id, status, match_reason, created_at',
    (q) => q.in('status', ['suggested', 'queued']))
  const shown = await pageAll(adminClient, 'batch_suggestions', 'recipient_id, suggested_id, reason', (q) => q.eq('status', 'shown'))
  const irByMember = new Map<string, any[]>()
  for (const r of irRows) { if (!memberSet.has(r.requester_id)) continue; (irByMember.get(r.requester_id) ?? irByMember.set(r.requester_id, []).get(r.requester_id)!).push(r) }
  const adminByMember = new Map<string, { target: string; reason: string | null }[]>()
  for (const r of shown) { if (!memberSet.has(r.recipient_id)) continue; (adminByMember.get(r.recipient_id) ?? adminByMember.set(r.recipient_id, []).get(r.recipient_id)!).push({ target: r.suggested_id, reason: r.reason ?? null }) }

  // Bulk-load every viewer + candidate profile once (alignment scoring + composition).
  const profileIds = new Set<string>([...Array.from(memberSet)])
  for (const r of irRows) profileIds.add(r.target_user_id)
  for (const r of shown) profileIds.add(r.suggested_id)
  const profileMap = new Map<string, any>()
  const idList = Array.from(profileIds)
  for (let i = 0; i < idList.length; i += 500) {
    const chunk = idList.slice(i, i + 500)
    const rows = await pageAll(adminClient, 'profiles', RANK_PROFILE_COLS, (q) => q.in('id', chunk))
    for (const p of rows) profileMap.set(p.id, p)
  }
  return { memberSet, irByMember, adminByMember, profileMap }
}

/**
 * PURE, deterministic selection — the single source of truth for Active/Queued/Discard,
 * shared by the dry-run plan and the write. Ranks a member's existing candidates by
 * alignment desc → match_reason signal strength desc → created_at desc → target_user_id
 * asc, then applies the law-firm composition policy (reorders only), then splits.
 */
function rankMemberItems(
  viewer: any,
  existing: any[],
  admin: { target: string; reason: string | null }[],
  profileMap: Map<string, any>,
): { active: QueueItem[]; queued: QueueItem[]; discard: QueueItem[] } {
  const seen = new Set<string>()
  const cands: any[] = []
  const pushCand = (target: string, reason: string | null, rowId: string | undefined, createdAt: string | null) => {
    if (seen.has(target)) return
    seen.add(target)
    const p = profileMap.get(target) ?? { id: target }
    cands.push({
      ...p,
      __item: { rowId, target, reason } as QueueItem,
      __alignment: calculateAlignmentScore(viewer, p),
      __signal: signalStrength(reason),
      __created: createdAt ?? '',
      __target: target,
    })
  }
  for (const r of existing) pushCand(r.target_user_id, r.match_reason ?? null, r.id, r.created_at ?? null)
  for (const a of admin) pushCand(a.target, a.reason, undefined, null)

  cands.sort((a, b) =>
    b.__alignment - a.__alignment
    || b.__signal - a.__signal
    || String(b.__created).localeCompare(String(a.__created))
    || String(a.__target).localeCompare(String(b.__target)))

  const composed = applyLawFirmCompositionPolicy(cands, viewer)
  const items: QueueItem[] = composed.map((c: any) => c.__item)
  return { active: items.slice(0, N), queued: items.slice(N, KEEP), discard: items.slice(KEEP) }
}

export interface BackfillPlan {
  members: number
  activeRecommendations: number
  queuedRecommendations: number
  recommendationsToMove: number       // existing rows changing suggested → queued
  recommendationsToDiscard: number
  adminMaterializations: number       // admin-sourced targets with no live row yet
  perMemberSample: Array<{ member: string; active: string[]; queued: string[]; discard: string[] }>
}

/**
 * READ-ONLY. The exact Active/Queued/Discard plan applyBackfill will execute, with no
 * writes — so the dry-run assignment is provably identical to the write (both call
 * rankMemberItems). Use this to review the ranking outcome before approving the write.
 */
export async function planBackfill(adminClient: any, sampleSize = 10): Promise<BackfillPlan> {
  const { memberSet, irByMember, adminByMember, profileMap } = await collectForApply(adminClient)
  let members = 0, active = 0, queued = 0, discard = 0, toMove = 0, adminMat = 0
  const sample: BackfillPlan['perMemberSample'] = []
  for (const memberId of Array.from(memberSet)) {
    const existing = irByMember.get(memberId) ?? []
    const admin = adminByMember.get(memberId) ?? []
    if (existing.length === 0 && admin.length === 0) continue
    members++
    const plan = rankMemberItems(profileMap.get(memberId) ?? {}, existing, admin, profileMap)
    active += plan.active.length
    queued += plan.queued.length
    discard += plan.discard.length
    toMove += plan.queued.filter((it) => it.rowId).length
    adminMat += [...plan.active, ...plan.queued].filter((it) => !it.rowId).length
    if (sample.length < sampleSize) sample.push({ member: memberId.slice(0, 8), active: plan.active.map((i) => i.target), queued: plan.queued.map((i) => i.target), discard: plan.discard.map((i) => i.target) })
  }
  return { members, activeRecommendations: active, queuedRecommendations: queued, recommendationsToMove: toMove, recommendationsToDiscard: discard, adminMaterializations: adminMat, perMemberSample: sample }
}

/**
 * WRITES. Collapse every member to Current (≤ N active) + Next (≤ N queued), discard
 * the rest. HELD — invoke only after explicit approval. See file header for the
 * idempotency / resume-safety contract.
 */
export async function applyBackfill(adminClient: any): Promise<BackfillApplyResult> {
  const { memberSet, irByMember, adminByMember, profileMap } = await collectForApply(adminClient)

  const now = new Date().toISOString()
  const res: BackfillApplyResult = { membersProcessed: 0, membersSkipped: 0, activeBatchesCreated: 0, queuedBatchesCreated: 0, recommendationsDiscarded: 0 }

  for (const memberId of Array.from(memberSet)) {
    const existing = irByMember.get(memberId) ?? []
    const admin = adminByMember.get(memberId) ?? []
    if (existing.length === 0 && admin.length === 0) continue

    // Idempotency: fully migrated members already have an ACTIVE batch — skip.
    const { data: activeRow } = await adminClient
      .from('recommendation_batches').select('batch_id').eq('member_id', memberId).eq('state', 'active').limit(1)
    if ((activeRow ?? []).length > 0) { res.membersSkipped++; continue }

    // Reset any partial state from a prior interrupted run to a clean baseline:
    // revert half-flipped 'queued' rows to 'suggested' and clear non-active batch
    // metadata. After this, a re-run behaves like a first run — no double-create.
    await adminClient.from('intro_requests').update({ status: 'suggested', batch_id: null })
      .eq('requester_id', memberId).eq('status', 'queued')
    await adminClient.from('recommendation_batches').delete()
      .eq('member_id', memberId).in('state', ['queued', 'completed', 'discarded'])

    // Deterministic Active/Queued/Discard selection (same function planBackfill uses).
    const { active: current, queued: next, discard } = rankMemberItems(profileMap.get(memberId) ?? {}, existing, admin, profileMap)
    res.recommendationsDiscarded += discard.length

    const batchIdA = randomUUID()
    const batchIdQ = next.length > 0 ? randomUUID() : null

    // Attach the active batch: UPDATE existing rows in place (preserve match_reason /
    // created_at), INSERT only for admin-sourced targets that have no live row yet.
    for (const it of current) {
      if (it.rowId) await adminClient.from('intro_requests').update({ status: 'suggested', batch_id: batchIdA, updated_at: now }).eq('id', it.rowId)
      else await adminClient.from('intro_requests').insert({ requester_id: memberId, target_user_id: it.target, status: 'suggested', match_reason: it.reason, batch_id: batchIdA, created_at: now, updated_at: now })
    }
    for (const it of next) {
      if (it.rowId) await adminClient.from('intro_requests').update({ status: 'queued', batch_id: batchIdQ, updated_at: now }).eq('id', it.rowId)
      else await adminClient.from('intro_requests').insert({ requester_id: memberId, target_user_id: it.target, status: 'queued', match_reason: it.reason, batch_id: batchIdQ, created_at: now, updated_at: now })
    }
    // Discard genuine excess — delete only these specific old rows (never matches,
    // pending, approved, or history).
    for (const it of discard) if (it.rowId) await adminClient.from('intro_requests').delete().eq('id', it.rowId)

    // Batch metadata LAST, queued before active. The active row is the skip sentinel,
    // so if interrupted before it lands, the next run re-cleans and redoes cleanly.
    if (batchIdQ) {
      await adminClient.from('recommendation_batches').insert({ batch_id: batchIdQ, member_id: memberId, batch_source: 'migration', state: 'queued', reciprocal_batch_id: null, created_at: now, generated_at: now, displayed_at: null, completed_at: null })
      res.queuedBatchesCreated++
    }
    if (current.length > 0) {
      await adminClient.from('recommendation_batches').insert({ batch_id: batchIdA, member_id: memberId, batch_source: 'migration', state: 'active', reciprocal_batch_id: null, created_at: now, generated_at: now, displayed_at: now, completed_at: null })
      res.activeBatchesCreated++
    }
    res.membersProcessed++
  }

  return res
}
