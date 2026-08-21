import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Idempotency guard for the admin "Approve & Go Live" (send) path. Proves a batch
 * can be approved exactly once: a second approval is refused BEFORE any enqueue,
 * so no duplicate intro_requests are materialized and no second email fires. Also
 * covers the UNIFIED Thursday-send routing: visible → new-batch email; queued +
 * unresolved → the shared "Action needed" reminder (same helper + ISO-week key as
 * weekly-refresh); queued + resolved → silent. materializeAdminPair/notifications are mocked
 * as recorders.
 */

const h = vi.hoisted(() => ({
  user: { id: 'admin', email: 'bizdev91@gmail.com' } as any,
  batchStatus: 'pending_review' as string,
  releases: [] as any[],
  suggestions: [] as any[],
  rpcCalls: [] as any[],
  outcomes: {} as Record<string, string>,
  notifyCalls: [] as any[],
  actionNeededCalls: [] as any[],
  placement: {} as Record<string, string>,  // memberId → 'active' | 'queued' (default active)
  unresolved: {} as Record<string, number>, // memberId → current unresolved count (default 0)
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }),
}))

vi.mock('@/lib/introductions/queue', () => ({
  countUnresolvedRecommendations: vi.fn(async (_admin: any, memberId: string) => h.unresolved[memberId] ?? 0),
}))

// Approval is now PAIR-atomic: one RPC call per undirected pair, writing both directions with one
// shared pair_id in ONE tier, instead of one place_batch_rows call per recipient. toUndirectedPairs
// is pure, so the REAL implementation is used — only the database call is mocked.
vi.mock('@/lib/introductions/materializeAdminPair', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    materializeAdminPair: vi.fn(async (_admin: any, opts: any) => {
      h.rpcCalls.push(opts)
      // Migration 064 places pairs in the VISIBLE tier only — a queued pair could be split by
      // promote_queued_rows, which acts on one member and is unaware of pair_id. `h.placement`
      // therefore selects between 'created' (visible) and a capacity refusal, not between tiers.
      const tier = h.placement[opts.memberA] ?? h.placement[opts.memberB] ?? 'active'
      const [lo, hi] = [opts.memberA, opts.memberB].sort()
      const outcome = h.outcomes[[lo, hi].join('|')] ?? (tier === 'active' ? 'created' : 'capacity')
      if (outcome !== 'created') return { outcome, tier: null, pairId: null, batchIdLo: null, batchIdHi: null }
      return {
        outcome: 'created',
        tier: 'suggested',                       // the ONLY tier this RPC can return
        pairId: 'pair-' + lo, batchIdLo: 'rb-' + lo, batchIdHi: 'rb-' + hi,
      }
    }),
  }
})

vi.mock('@/lib/notifications/engagement', () => ({
  notifyAdminBatchReady: vi.fn(async (memberId: string, batchId: string, count?: number) => {
    h.notifyCalls.push({ memberId, batchId, count })
  }),
  // Shared reminder helper (same one weekly-refresh calls). Default: sent successfully.
  notifyPendingIntrosActionNeeded: vi.fn(async (memberId: string, activeBatchId: string, cycleKey: string) => {
    h.actionNeededCalls.push({ memberId, activeBatchId, cycleKey })
    return { handled: true, emailed: true, skipped: false, alreadyHandled: false }
  }),
  isoWeekKey: () => '2026-W32',
}))

vi.mock('@/lib/supabase/admin', () => {
  const from = (table: string) => {
    const b: any = { _t: table, _op: 'select', _patch: null as any, _eqs: [] as any[], _single: false }
    b.select = () => b
    b.update = (p: any) => { b._op = 'update'; b._patch = p; return b }
    b.eq = (c: string, v: any) => { b._eqs.push([c, v]); return b }
    b.maybeSingle = () => { b._single = true; return b }
    const getEq = (c: string) => (b._eqs.find((e: any[]) => e[0] === c) || [])[1]
    const exec = async () => {
      if (b._t === 'introduction_batches') {
        if (b._op === 'update') {
          if (b._patch?.status === 'active' && getEq('id')) h.batchStatus = 'active'
          return { data: null, error: null }
        }
        return { data: h.batchStatus === null ? null : { id: getEq('id'), status: h.batchStatus }, error: null }
      }
      if (b._t === 'batch_suggestions') {
        if (b._op === 'update') return { data: null, error: null }
        return { data: h.suggestions, error: null }
      }
      return { data: [], error: null }
    }
    b.then = (res: any, rej: any) => exec().then(res, rej)
    return b
  }
  return { createAdminClient: () => ({ from }) }
})

import { POST } from '@/app/api/admin/approve-batch/route'
import { materializeAdminPair } from '@/lib/introductions/materializeAdminPair'
import { notifyAdminBatchReady, notifyPendingIntrosActionNeeded } from '@/lib/notifications/engagement'

const post = () => POST(new Request('http://x/api/admin/approve-batch', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchId: 'batch-1' }),
}) as any)

beforeEach(() => {
  h.user = { id: 'admin', email: 'bizdev91@gmail.com' }
  h.batchStatus = 'pending_review'
  // SYMMETRIC review rows — one undirected pair {m1,m2}. A proposal without its mirror is the
  // one-sided shape that produced the 145 historical rows, and is never approvable.
  h.suggestions = [
    { recipient_id: 'm1', suggested_id: 'm2', reason: 'r', position: 0 },
    { recipient_id: 'm2', suggested_id: 'm1', reason: 'r', position: 0 },
  ]
  h.rpcCalls = []
  h.outcomes = {}
  h.notifyCalls = []
  h.actionNeededCalls = []
  h.placement = {}
  h.unresolved = {}
  ;(materializeAdminPair as any).mockClear()
  ;(notifyAdminBatchReady as any).mockClear()
  ;(notifyPendingIntrosActionNeeded as any).mockClear()
})

describe('approve-batch — idempotency guard', () => {
  it('1. first approval succeeds and materializes the batch', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.placed, 'both members of the pair are placed').toBe(2)
    expect(h.rpcCalls, 'ONE call per undirected pair, not per recipient').toHaveLength(1)
    expect(body.pairsConsidered).toBe(1)
    expect(body.pairsCreatedVisible).toBe(1)
    expect(body.outcomes).toMatchObject({ created: 1 })
    expect(h.batchStatus).toBe('active')
  })

  it('2. a second approval does NOT enqueue again (no duplicate intro_requests)', async () => {
    await post()
    const callsAfterFirst = h.rpcCalls.length
    expect(callsAfterFirst).toBe(1)
    const res2 = await post()
    expect(res2.status).toBe(409)
    const body2 = await res2.json()
    expect(body2.alreadyProcessed).toBe(true)
    expect(body2.status).toBe('active')
    expect(h.rpcCalls.length).toBe(callsAfterFirst)
    expect(materializeAdminPair).toHaveBeenCalledTimes(1)
  })

  it('3. email notification behavior is unchanged (fires once on first approval, not on re-approval)', async () => {
    await post()
    expect(h.notifyCalls).toHaveLength(2)
    expect(notifyAdminBatchReady).toHaveBeenCalledTimes(2)
    await post()
    expect(h.notifyCalls).toHaveLength(2)
    expect(notifyAdminBatchReady).toHaveBeenCalledTimes(2)
  })

  it('refuses approval from other terminal states (completed) without mutating', async () => {
    h.batchStatus = 'completed'
    const res = await post()
    expect(res.status).toBe(409)
    expect(h.rpcCalls).toHaveLength(0)
    expect(notifyAdminBatchReady).not.toHaveBeenCalled()
  })

  it('404 when the batch does not exist (and nothing enqueued)', async () => {
    h.batchStatus = null as any
    const res = await post()
    expect(res.status).toBe(404)
    expect(h.rpcCalls).toHaveLength(0)
    expect(notifyAdminBatchReady).not.toHaveBeenCalled()
  })
})

describe('approve-batch — canonical Thursday send routing (visible vs action-needed vs resolved)', () => {
  it('routes each recipient to the correct email path', async () => {
    // Both members of a pair now share ONE tier by construction, so the three routing cases must
    // be three separate PAIRS rather than three recipients of a single batch.
    //   {m1,n1} visible                              -> new-batch email to BOTH
    //   {m2,n2} queued, m2 unresolved / n2 resolved  -> reminder to m2 only, n2 silent
    //   {m3,n3} queued, both resolved                -> silent
    h.suggestions = [
      { recipient_id: 'm1', suggested_id: 'n1', reason: 'r', position: 0 },
      { recipient_id: 'n1', suggested_id: 'm1', reason: 'r', position: 0 },
      { recipient_id: 'm2', suggested_id: 'n2', reason: 'r', position: 0 },
      { recipient_id: 'n2', suggested_id: 'm2', reason: 'r', position: 0 },
      { recipient_id: 'm3', suggested_id: 'n3', reason: 'r', position: 0 },
      { recipient_id: 'n3', suggested_id: 'm3', reason: 'r', position: 0 },
    ]
    h.placement = { m1: 'active', n1: 'active', m2: 'queued', n2: 'queued', m3: 'queued', n3: 'queued' }
    h.unresolved = { m2: 2, n2: 0, m3: 0, n3: 0 }

    const res = await post()
    const body = await res.json()
    expect(res.status).toBe(200)

    // Visible → new-batch email to BOTH members of that pair; NOT the reminder.
    expect(h.notifyCalls.map((c) => c.memberId).sort()).toEqual(['m1', 'n1'])
    // The two pairs without visible room are REFUSED for capacity, not queued — 064 never places a
    // pair in the reserved tier, so the action-needed path is unreachable for admin pairs and the
    // members are simply left as they were, with their proposals still reviewable.
    expect(h.actionNeededCalls).toHaveLength(0)
    expect(body).toMatchObject({ batchVisible: 2, actionNeeded: 0 })
    expect(body.outcomes).toMatchObject({ created: 1, capacity: 2 })
    expect(body.cycleKey).toBe('2026-W32')
  })

  it('a capacity-refused pair produces no notification of any kind', async () => {
    h.suggestions = [
      { recipient_id: 'm2', suggested_id: 'n2', reason: 'r', position: 0 },
      { recipient_id: 'n2', suggested_id: 'm2', reason: 'r', position: 0 },
    ]
    h.placement = { m2: 'queued', n2: 'queued' }
    h.unresolved = { m2: 3, n2: 0 }
    await post()
    // A capacity-refused pair notifies NOBODY: no new-batch email, no reminder, no signal of any
    // kind. Silence is the correct behaviour — nothing landed on either member's screen.
    expect(notifyPendingIntrosActionNeeded).not.toHaveBeenCalled()
    expect(notifyAdminBatchReady).not.toHaveBeenCalled()
    expect(h.actionNeededCalls).toHaveLength(0)
  })

  it('a resolved queued member (no unresolved current intros) receives nothing', async () => {
    h.suggestions = [
      { recipient_id: 'm3', suggested_id: 'n3', reason: 'r', position: 0 },
      { recipient_id: 'n3', suggested_id: 'm3', reason: 'r', position: 0 },
    ]
    h.placement = { m3: 'queued', n3: 'queued' }
    h.unresolved = { m3: 0, n3: 0 }
    await post()
    expect(notifyAdminBatchReady).not.toHaveBeenCalled()
    expect(notifyPendingIntrosActionNeeded).not.toHaveBeenCalled()
  })

  it('retrying approval does not notify again (the 409 guard blocks the re-run)', async () => {
    // Uses a PLACEABLE pair, since a capacity-refused one notifies nobody and could not detect a
    // double-send at all. Both members are told once, and a retry adds nothing.
    h.suggestions = [
      { recipient_id: 'm1', suggested_id: 'n1', reason: 'r', position: 0 },
      { recipient_id: 'n1', suggested_id: 'm1', reason: 'r', position: 0 },
    ]
    h.placement = { m1: 'active', n1: 'active' }
    await post()
    expect(notifyAdminBatchReady).toHaveBeenCalledTimes(2)   // one per member of the pair
    const res2 = await post()
    expect(res2.status).toBe(409)
    expect(notifyAdminBatchReady).toHaveBeenCalledTimes(2)   // unchanged by the retry
    expect(notifyPendingIntrosActionNeeded).not.toHaveBeenCalled()
  })
})
