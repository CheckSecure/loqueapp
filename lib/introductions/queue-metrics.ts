/**
 * Recommendation-queue analytics. Two families:
 *   • getQueueHealthMetrics  — operational, per-member queue-state counts for the
 *     admin dashboard (never shown to members).
 *   • getBatchLifecycleMetrics — batch timing (generated→displayed, displayed→
 *     completed) plus interest / pass / match rates over recommendation rows.
 *
 * Both read the service-role client. All timing is derived from the lifecycle
 * timestamps on recommendation_batches (migration 020).
 */
import { EXPRESSED_INTEREST_STATUSES } from '@/lib/introductions/queue'

export interface QueueHealthMetrics {
  totalActiveMembers: number
  noActiveBatch: number
  activeBatchOnly: number
  withQueuedBatch: number
  waitingForWeeklyGeneration: number
  waitingOnAdminBatch: number
}

/**
 * Per-member queue-state census across active, profile-complete members.
 *   • noActiveBatch            — no ACTIVE batch (nothing visible right now)
 *   • activeBatchOnly          — one ACTIVE batch, nothing queued
 *   • withQueuedBatch          — one ACTIVE + one QUEUED batch
 *   • waitingForWeeklyGeneration — no active AND no queued (resolved everything;
 *     the weekly engine will generate their next batch)
 *   • waitingOnAdminBatch      — a QUEUED admin reciprocal batch not yet promoted
 */
export async function getQueueHealthMetrics(adminClient: any): Promise<QueueHealthMetrics> {
  const { data: members } = await adminClient
    .from('profiles')
    .select('id')
    .eq('account_status', 'active')
    .eq('profile_complete', true)
    .not('is_test_account', 'is', true)
  const memberIds = new Set<string>((members ?? []).map((m: any) => m.id))

  const { data: batches } = await adminClient
    .from('recommendation_batches')
    .select('member_id, state, batch_source')
    .in('state', ['active', 'queued'])

  const activeBy = new Set<string>()
  const queuedBy = new Set<string>()
  const queuedAdminBy = new Set<string>()
  for (const b of batches ?? []) {
    if (!memberIds.has(b.member_id)) continue
    if (b.state === 'active') activeBy.add(b.member_id)
    else if (b.state === 'queued') {
      queuedBy.add(b.member_id)
      if (b.batch_source === 'admin_reciprocal') queuedAdminBy.add(b.member_id)
    }
  }

  let noActiveBatch = 0
  let activeBatchOnly = 0
  let withQueuedBatch = 0
  let waitingForWeeklyGeneration = 0
  for (const id of Array.from(memberIds)) {
    const hasActive = activeBy.has(id)
    const hasQueued = queuedBy.has(id)
    if (!hasActive) {
      noActiveBatch++
      if (!hasQueued) waitingForWeeklyGeneration++
    } else if (hasQueued) {
      withQueuedBatch++
    } else {
      activeBatchOnly++
    }
  }

  return {
    totalActiveMembers: memberIds.size,
    noActiveBatch,
    activeBatchOnly,
    withQueuedBatch,
    waitingForWeeklyGeneration,
    waitingOnAdminBatch: queuedAdminBy.size,
  }
}

export interface BatchLifecycleMetrics {
  batchesTotal: number
  batchesCompleted: number
  avgQueueWaitMs: number | null      // generated_at → displayed_at (time spent queued)
  avgResolutionMs: number | null     // displayed_at → completed_at (active → resolved)
  recommendationsTotal: number
  interestRate: number | null        // share of recs the member expressed interest in
  passRate: number | null            // share of recs the member passed / hid
  matchRate: number | null           // share of recs that became a mutual match
}

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length)
}

/**
 * Aggregate batch timing + outcome rates. Timing from recommendation_batches
 * lifecycle stamps; rates from the intro_requests rows those batches produced,
 * cross-referenced against expressed-interest rows and matches.
 */
export async function getBatchLifecycleMetrics(adminClient: any): Promise<BatchLifecycleMetrics> {
  const { data: batches } = await adminClient
    .from('recommendation_batches')
    .select('batch_id, member_id, state, generated_at, displayed_at, completed_at')

  const all = (batches ?? []) as any[]
  const queueWaits: number[] = []
  const resolutions: number[] = []
  for (const b of all) {
    if (b.displayed_at && b.generated_at) {
      const w = new Date(b.displayed_at).getTime() - new Date(b.generated_at).getTime()
      if (Number.isFinite(w) && w >= 0) queueWaits.push(w)
    }
    if (b.completed_at && b.displayed_at) {
      const r = new Date(b.completed_at).getTime() - new Date(b.displayed_at).getTime()
      if (Number.isFinite(r) && r >= 0) resolutions.push(r)
    }
  }

  // Recommendation-row outcomes. A batch's recommendation rows live in intro_requests
  // keyed by batch_id; expressed interest is a separate outbound row per target.
  const batchIds = all.map((b) => b.batch_id)
  let recommendationsTotal = 0
  let interested = 0
  let passed = 0
  let matched = 0
  if (batchIds.length > 0) {
    const { data: rows } = await adminClient
      .from('intro_requests')
      .select('requester_id, target_user_id, status')
      .in('batch_id', batchIds)
    const recs = (rows ?? []) as any[]
    recommendationsTotal = recs.length

    // Expressed interest per (requester, target).
    const { data: expressedRows } = await adminClient
      .from('intro_requests')
      .select('requester_id, target_user_id')
      .in('status', EXPRESSED_INTEREST_STATUSES as unknown as string[])
    const expressed = new Set((expressedRows ?? []).map((r: any) => `${r.requester_id}:${r.target_user_id}`))

    const { data: matchRows } = await adminClient.from('matches').select('user_a_id, user_b_id')
    const matchedPair = new Set<string>()
    for (const m of matchRows ?? []) {
      matchedPair.add(`${m.user_a_id}:${m.user_b_id}`)
      matchedPair.add(`${m.user_b_id}:${m.user_a_id}`)
    }

    for (const r of recs) {
      if (r.status === 'passed' || r.status === 'hidden' || r.status === 'hidden_permanent') passed++
      if (expressed.has(`${r.requester_id}:${r.target_user_id}`)) interested++
      if (matchedPair.has(`${r.requester_id}:${r.target_user_id}`)) matched++
    }
  }

  const rate = (n: number) => (recommendationsTotal > 0 ? Math.round((n / recommendationsTotal) * 1000) / 1000 : null)

  return {
    batchesTotal: all.length,
    batchesCompleted: all.filter((b) => b.state === 'completed').length,
    avgQueueWaitMs: avg(queueWaits),
    avgResolutionMs: avg(resolutions),
    recommendationsTotal,
    interestRate: rate(interested),
    passRate: rate(passed),
    matchRate: rate(matched),
  }
}
