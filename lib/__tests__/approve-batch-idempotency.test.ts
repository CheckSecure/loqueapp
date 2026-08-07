import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Idempotency guard for the admin "Approve & Go Live" (send) path. Proves a batch
 * can be approved exactly once: a second approval is refused BEFORE any enqueue,
 * so no duplicate intro_requests are materialized and no second email fires. Also
 * covers the UNIFIED Thursday-send routing: visible → new-batch email; queued +
 * unresolved → the shared "Action needed" reminder (same helper + ISO-week key as
 * weekly-refresh); queued + resolved → silent. enqueueBatch/notifications are mocked
 * as recorders.
 */

const h = vi.hoisted(() => ({
  user: { id: 'admin', email: 'bizdev91@gmail.com' } as any,
  batchStatus: 'pending_review' as string,
  suggestions: [] as any[],
  enqueueCalls: [] as any[],
  notifyCalls: [] as any[],
  actionNeededCalls: [] as any[],
  placement: {} as Record<string, string>,  // memberId → 'active' | 'queued' (default active)
  unresolved: {} as Record<string, number>, // memberId → current unresolved count (default 0)
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }),
}))

vi.mock('@/lib/introductions/queue', () => ({
  enqueueBatch: vi.fn(async (_admin: any, opts: any) => {
    h.enqueueCalls.push(opts)
    return { placed: true, state: h.placement[opts.memberId] ?? 'active', batchId: 'rb-' + opts.memberId, count: opts.rows.length }
  }),
  countUnresolvedRecommendations: vi.fn(async (_admin: any, memberId: string) => h.unresolved[memberId] ?? 0),
}))

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
import { enqueueBatch } from '@/lib/introductions/queue'
import { notifyAdminBatchReady, notifyPendingIntrosActionNeeded } from '@/lib/notifications/engagement'

const post = () => POST(new Request('http://x/api/admin/approve-batch', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchId: 'batch-1' }),
}) as any)

beforeEach(() => {
  h.user = { id: 'admin', email: 'bizdev91@gmail.com' }
  h.batchStatus = 'pending_review'
  h.suggestions = [
    { recipient_id: 'm1', suggested_id: 't1', reason: 'r', position: 0 },
    { recipient_id: 'm2', suggested_id: 't2', reason: 'r', position: 0 },
  ]
  h.enqueueCalls = []
  h.notifyCalls = []
  h.actionNeededCalls = []
  h.placement = {}
  h.unresolved = {}
  ;(enqueueBatch as any).mockClear()
  ;(notifyAdminBatchReady as any).mockClear()
  ;(notifyPendingIntrosActionNeeded as any).mockClear()
})

describe('approve-batch — idempotency guard', () => {
  it('1. first approval succeeds and materializes the batch', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.placed).toBe(2)
    expect(h.enqueueCalls).toHaveLength(2)
    expect(h.batchStatus).toBe('active')
  })

  it('2. a second approval does NOT enqueue again (no duplicate intro_requests)', async () => {
    await post()
    const enqueueAfterFirst = h.enqueueCalls.length
    expect(enqueueAfterFirst).toBe(2)
    const res2 = await post()
    expect(res2.status).toBe(409)
    const body2 = await res2.json()
    expect(body2.alreadyProcessed).toBe(true)
    expect(body2.status).toBe('active')
    expect(h.enqueueCalls.length).toBe(enqueueAfterFirst)
    expect(enqueueBatch).toHaveBeenCalledTimes(2)
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
    expect(h.enqueueCalls).toHaveLength(0)
    expect(notifyAdminBatchReady).not.toHaveBeenCalled()
  })

  it('404 when the batch does not exist (and nothing enqueued)', async () => {
    h.batchStatus = null as any
    const res = await post()
    expect(res.status).toBe(404)
    expect(h.enqueueCalls).toHaveLength(0)
    expect(notifyAdminBatchReady).not.toHaveBeenCalled()
  })
})

describe('approve-batch — canonical Thursday send routing (visible vs action-needed vs resolved)', () => {
  it('routes each recipient to the correct email path', async () => {
    // m1 visible; m2 queued WITH unresolved current intros; m3 queued but RESOLVED.
    h.suggestions = [
      { recipient_id: 'm1', suggested_id: 't1', reason: 'r', position: 0 },
      { recipient_id: 'm2', suggested_id: 't2', reason: 'r', position: 0 },
      { recipient_id: 'm3', suggested_id: 't3', reason: 'r', position: 0 },
    ]
    h.placement = { m1: 'active', m2: 'queued', m3: 'queued' }
    h.unresolved = { m2: 2, m3: 0 }

    const res = await post()
    const body = await res.json()
    expect(res.status).toBe(200)

    // Visible → new-batch email; NOT the reminder.
    expect(h.notifyCalls.map((c) => c.memberId)).toEqual(['m1'])
    // Queued + unresolved → the shared "Action needed" reminder, for m2 only.
    expect(h.actionNeededCalls.map((c) => c.memberId)).toEqual(['m2'])
    // Queued + resolved (m3) → nothing.
    expect(body).toMatchObject({ batchVisible: 1, actionNeeded: 1, otherSkipped: 1 })
    expect(body.cycleKey).toBe('2026-W32')
  })

  it('the action-needed reminder passes ONLY memberId + batch ref + the shared ISO-week cycle key', async () => {
    h.suggestions = [{ recipient_id: 'm2', suggested_id: 't2', reason: 'r', position: 0 }]
    h.placement = { m2: 'queued' }
    h.unresolved = { m2: 3 }
    await post()
    expect(notifyPendingIntrosActionNeeded).toHaveBeenCalledTimes(1)
    const call = h.actionNeededCalls[0]
    expect(call.memberId).toBe('m2')
    expect(call.activeBatchId).toBe('rb-m2')
    expect(call.cycleKey).toBe('2026-W32') // shared dedupe identity with weekly-refresh
  })

  it('a resolved queued member (no unresolved current intros) receives nothing', async () => {
    h.suggestions = [{ recipient_id: 'm3', suggested_id: 't3', reason: 'r', position: 0 }]
    h.placement = { m3: 'queued' }
    h.unresolved = { m3: 0 }
    await post()
    expect(notifyAdminBatchReady).not.toHaveBeenCalled()
    expect(notifyPendingIntrosActionNeeded).not.toHaveBeenCalled()
  })

  it('retrying approval does not fire the reminder again (guard blocks re-run)', async () => {
    h.suggestions = [{ recipient_id: 'm2', suggested_id: 't2', reason: 'r', position: 0 }]
    h.placement = { m2: 'queued' }
    h.unresolved = { m2: 2 }
    await post()
    expect(notifyPendingIntrosActionNeeded).toHaveBeenCalledTimes(1)
    const res2 = await post()
    expect(res2.status).toBe(409)
    expect(notifyPendingIntrosActionNeeded).toHaveBeenCalledTimes(1)
  })
})
