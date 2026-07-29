import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Idempotency guard for the admin "Approve & Go Live" (send) path. Proves a batch
 * can be approved exactly once: a second approval is refused BEFORE any enqueue,
 * so no duplicate intro_requests are materialized and no second email fires. The
 * guard is the only change — enqueueBatch, notification, matching, and exclusion
 * logic are untouched (here mocked as recorders to observe call counts).
 */

const h = vi.hoisted(() => ({
  user: { id: 'admin', email: 'bizdev91@gmail.com' } as any,
  batchStatus: 'pending_review' as string,
  suggestions: [] as any[],
  enqueueCalls: [] as any[],
  notifyCalls: [] as any[],
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }),
}))

vi.mock('@/lib/introductions/queue', () => ({
  // Recorder — placed ACTIVE so the notification path is exercised on first approval.
  enqueueBatch: vi.fn(async (_admin: any, opts: any) => {
    h.enqueueCalls.push(opts)
    return { placed: true, state: 'active', batchId: 'rb-' + opts.memberId, count: opts.rows.length }
  }),
}))

vi.mock('@/lib/notifications/engagement', () => ({
  notifyNewVisibleBatch: vi.fn(async (memberId: string, batchId: string, count?: number) => {
    h.notifyCalls.push({ memberId, batchId, count })
  }),
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
          // Simulate persistence: activating THIS batch (eq id) flips its status.
          if (b._patch?.status === 'active' && getEq('id')) h.batchStatus = 'active'
          return { data: null, error: null }
        }
        // select .eq('id', ...).maybeSingle() — null batchStatus models a missing row.
        return { data: h.batchStatus === null ? null : { id: getEq('id'), status: h.batchStatus }, error: null }
      }
      if (b._t === 'batch_suggestions') {
        if (b._op === 'update') return { data: null, error: null }
        return { data: h.suggestions, error: null } // shown-rows loader
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
import { notifyNewVisibleBatch } from '@/lib/notifications/engagement'

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
  ;(enqueueBatch as any).mockClear()
  ;(notifyNewVisibleBatch as any).mockClear()
})

describe('approve-batch — idempotency guard', () => {
  it('1. first approval succeeds and materializes the batch', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.placed).toBe(2)
    expect(h.enqueueCalls).toHaveLength(2)           // one enqueue per recipient
    expect(h.batchStatus).toBe('active')             // batch moved out of pending_review
  })

  it('2. a second approval does NOT enqueue again (no duplicate intro_requests)', async () => {
    await post()                                     // first: pending_review → active
    const enqueueAfterFirst = h.enqueueCalls.length
    expect(enqueueAfterFirst).toBe(2)

    const res2 = await post()                        // second: status now 'active'
    expect(res2.status).toBe(409)
    const body2 = await res2.json()
    expect(body2.alreadyProcessed).toBe(true)
    expect(body2.status).toBe('active')
    // enqueueBatch was NOT called again — nothing new materialized.
    expect(h.enqueueCalls.length).toBe(enqueueAfterFirst)
    expect(enqueueBatch).toHaveBeenCalledTimes(2)    // still only the first approval's calls
  })

  it('3. email notification behavior is unchanged (fires once on first approval, not on re-approval)', async () => {
    await post()
    expect(h.notifyCalls).toHaveLength(2)            // active placements announced (as before)
    expect(notifyNewVisibleBatch).toHaveBeenCalledTimes(2)

    await post()                                     // re-approval short-circuits at the guard
    expect(h.notifyCalls).toHaveLength(2)            // no additional emails
    expect(notifyNewVisibleBatch).toHaveBeenCalledTimes(2)
  })

  it('refuses approval from other terminal states (completed) without mutating', async () => {
    h.batchStatus = 'completed'
    const res = await post()
    expect(res.status).toBe(409)
    expect(h.enqueueCalls).toHaveLength(0)
    expect(notifyNewVisibleBatch).not.toHaveBeenCalled()
  })

  it('404 when the batch does not exist (and nothing enqueued)', async () => {
    h.batchStatus = null as any // models a missing introduction_batches row
    const res = await post()
    expect(res.status).toBe(404)
    expect(h.enqueueCalls).toHaveLength(0)
    expect(notifyNewVisibleBatch).not.toHaveBeenCalled()
  })
})
