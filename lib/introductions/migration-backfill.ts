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

/**
 * WRITES. Collapse every member to Current (≤ N active) + Next (≤ N queued), discard
 * the rest. HELD — invoke only after explicit approval. See file header for the
 * idempotency / resume-safety contract.
 */
export async function applyBackfill(adminClient: any): Promise<BackfillApplyResult> {
  const memberSet = await activeMemberIds(adminClient)

  // Bulk-read existing queue-candidate rows (suggested OR a partial 'queued' from a
  // prior interrupted run) and sent admin suggestions, grouped per member.
  const irRows = await pageAll(adminClient, 'intro_requests', 'id, requester_id, target_user_id, status, match_reason, created_at',
    (q) => q.in('status', ['suggested', 'queued']))
  const shown = await pageAll(adminClient, 'batch_suggestions', 'recipient_id, suggested_id, reason', (q) => q.eq('status', 'shown'))

  const irByMember = new Map<string, any[]>()
  for (const r of irRows) { if (!memberSet.has(r.requester_id)) continue; (irByMember.get(r.requester_id) ?? irByMember.set(r.requester_id, []).get(r.requester_id)!).push(r) }
  const adminByMember = new Map<string, { target: string; reason: string | null }[]>()
  for (const r of shown) { if (!memberSet.has(r.recipient_id)) continue; (adminByMember.get(r.recipient_id) ?? adminByMember.set(r.recipient_id, []).get(r.recipient_id)!).push({ target: r.suggested_id, reason: r.reason ?? null }) }

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

    // Ordered visible union: live rows first (most recent first — matches the page's
    // created_at DESC display order), then any sent admin targets, deduped by target.
    const liveSorted = existing.slice().sort((a: any, b: any) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
    const items: QueueItem[] = []
    const seen = new Set<string>()
    for (const r of liveSorted) if (!seen.has(r.target_user_id)) { seen.add(r.target_user_id); items.push({ rowId: r.id, target: r.target_user_id, reason: r.match_reason ?? null }) }
    for (const a of admin) if (!seen.has(a.target)) { seen.add(a.target); items.push({ target: a.target, reason: a.reason }) }

    const current = items.slice(0, N)
    const next = items.slice(N, KEEP)
    const discard = items.slice(KEEP)
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
