/**
 * Unified Recommendation Queue — one-time migration of existing members onto the
 * active-window model. Two entry points:
 *
 *   • buildBackfillReport(adminClient)  — READ-ONLY. Produces the JSON dry-run
 *     report (member counts, visible-recommendation distribution, how many recs
 *     would be discarded, how many admin batches would materialize). Safe to run
 *     any time; mutates nothing.
 *
 *   • applyBackfill(adminClient)        — WRITES. Collapses each member to Current
 *     (≤ N active) + Next (≤ N queued) and DISCARDS everything beyond (deleted, not
 *     archived — those rows were produced under the old model; fresh > stale). HELD:
 *     never invoked automatically; runs only after explicit operator approval of the
 *     report and the schema migration.
 *
 * "Visible" today = a member's live recommendations (intro_requests status
 * 'suggested') plus any SENT admin reciprocal suggestions (batch_suggestions status
 * 'shown'), deduped by target. That is exactly the set the pre-migration UI could
 * show, so it is the correct basis for the collapse.
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

interface MemberVisible {
  memberId: string
  suggestedTargets: string[] // from intro_requests 'suggested' (deduped, ordered)
  sentAdminTargets: string[] // from batch_suggestions 'shown'
  visibleCount: number       // deduped union size
}

async function collectVisible(adminClient: any): Promise<{ members: string[]; perMember: Map<string, MemberVisible>; adminBatchIds: Set<string> }> {
  const { data: memberRows } = await adminClient
    .from('profiles')
    .select('id')
    .eq('account_status', 'active')
    .eq('profile_complete', true)
    .not('is_test_account', 'is', true)
  const members: string[] = (memberRows ?? []).map((m: any) => m.id)
  const memberSet = new Set(members)

  const { data: suggestedRows } = await adminClient
    .from('intro_requests')
    .select('requester_id, target_user_id, created_at')
    .eq('status', 'suggested')
  const { data: shownRows } = await adminClient
    .from('batch_suggestions')
    .select('recipient_id, suggested_id, batch_id')
    .eq('status', 'shown')

  const perMember = new Map<string, MemberVisible>()
  const ensure = (id: string): MemberVisible => {
    let mv = perMember.get(id)
    if (!mv) { mv = { memberId: id, suggestedTargets: [], sentAdminTargets: [], visibleCount: 0 }; perMember.set(id, mv) }
    return mv
  }
  for (const r of suggestedRows ?? []) {
    if (!memberSet.has(r.requester_id)) continue
    ensure(r.requester_id).suggestedTargets.push(r.target_user_id)
  }
  const adminBatchIds = new Set<string>()
  for (const r of shownRows ?? []) {
    if (!memberSet.has(r.recipient_id)) continue
    ensure(r.recipient_id).sentAdminTargets.push(r.suggested_id)
    if (r.batch_id) adminBatchIds.add(r.batch_id)
  }
  for (const mv of Array.from(perMember.values())) {
    mv.visibleCount = new Set([...mv.suggestedTargets, ...mv.sentAdminTargets]).size
  }
  return { members, perMember, adminBatchIds }
}

export async function buildBackfillReport(adminClient: any): Promise<BackfillReport> {
  const { members, perMember, adminBatchIds } = await collectVisible(adminClient)

  const dist = { '0': 0, '1': 0, '2': 0, '3': 0, '4plus': 0 }
  let usersOver = 0
  let toDiscard = 0
  for (const id of members) {
    const v = perMember.get(id)?.visibleCount ?? 0
    if (v >= 4) dist['4plus']++
    else (dist as any)[String(v)]++
    if (v > N) usersOver++
    if (v > KEEP) toDiscard += v - KEEP
  }

  return {
    batchSize: N,
    totalMembers: members.length,
    usersSeeingMoreThanBatchSize: usersOver,
    visibleDistribution: dist,
    recommendationsToDiscard: toDiscard,
    adminSuggestionBatchesToMaterialize: adminBatchIds.size,
    generatedAtNote: 'Timestamp stamped by the caller (scripts cannot call Date.now()).',
  }
}

export interface BackfillApplyResult {
  membersProcessed: number
  activeBatchesCreated: number
  queuedBatchesCreated: number
  recommendationsDiscarded: number
}

/**
 * WRITES. Collapse every member to Current (≤ N active) + Next (≤ N queued),
 * discard the rest. HELD — invoke only after explicit approval. Idempotent-ish:
 * members already holding a recommendation_batches active row are skipped.
 */
export async function applyBackfill(adminClient: any): Promise<BackfillApplyResult> {
  const { members, perMember } = await collectVisible(adminClient)
  const now = new Date().toISOString()
  let activeCreated = 0
  let queuedCreated = 0
  let discarded = 0
  let processed = 0

  for (const memberId of members) {
    const mv = perMember.get(memberId)
    if (!mv || mv.visibleCount === 0) continue

    // Skip members already migrated (they have a recommendation_batches row).
    const { data: existing } = await adminClient
      .from('recommendation_batches').select('batch_id').eq('member_id', memberId).limit(1)
    if ((existing ?? []).length > 0) continue

    processed++
    // Union of visible targets, live 'suggested' first (they are the current active).
    const ordered: string[] = []
    const seen = new Set<string>()
    for (const t of [...mv.suggestedTargets, ...mv.sentAdminTargets]) {
      if (!seen.has(t)) { seen.add(t); ordered.push(t) }
    }
    const current = ordered.slice(0, N)
    const next = ordered.slice(N, KEEP)
    const discard = ordered.slice(KEEP)
    discarded += discard.length

    // Delete every existing 'suggested'/'queued' row for this member — we rebuild
    // the two batches cleanly below.
    await adminClient.from('intro_requests').delete()
      .eq('requester_id', memberId).in('status', ['suggested', 'queued'])

    if (current.length > 0) {
      const batchId = randomUUID()
      await adminClient.from('recommendation_batches').insert({
        batch_id: batchId, member_id: memberId, batch_source: 'migration', state: 'active',
        reciprocal_batch_id: null, created_at: now, generated_at: now, displayed_at: now, completed_at: null,
      })
      await adminClient.from('intro_requests').insert(current.map((t) => ({
        requester_id: memberId, target_user_id: t, status: 'suggested', batch_id: batchId, created_at: now, updated_at: now,
      })))
      activeCreated++
    }
    if (next.length > 0) {
      const batchId = randomUUID()
      await adminClient.from('recommendation_batches').insert({
        batch_id: batchId, member_id: memberId, batch_source: 'migration', state: 'queued',
        reciprocal_batch_id: null, created_at: now, generated_at: now, displayed_at: null, completed_at: null,
      })
      await adminClient.from('intro_requests').insert(next.map((t) => ({
        requester_id: memberId, target_user_id: t, status: 'queued', batch_id: batchId, created_at: now, updated_at: now,
      })))
      queuedCreated++
    }
  }

  return { membersProcessed: processed, activeBatchesCreated: activeCreated, queuedBatchesCreated: queuedCreated, recommendationsDiscarded: discarded }
}
