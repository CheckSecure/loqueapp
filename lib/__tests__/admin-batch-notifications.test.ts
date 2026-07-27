import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Regression coverage for the admin-reciprocal duplicate-email fix.
 *
 * Root cause (fixed): app/api/admin/approve-batch/route.ts used to notify + email
 * EVERY placed admin batch — including HIDDEN queued ones — with a dedupe-key-less
 * new_batch notification. When that queued batch was later promoted, the shared
 * helper (notifyNewVisibleBatch, dedupeKey batch:<id>) emailed again → premature +
 * duplicate email. The route now announces ONLY active placements, through the same
 * shared helper, so approval and promotion deduplicate against each other.
 *
 * Part A exercises the REAL queue engine (enqueueBatch / promoteIfResolved) against
 * an in-memory Supabase mock and asserts the exact gate the route applies
 * (shouldNotifyVisibleBatch) plus the stable dedupe key. Part B exercises the REAL
 * notifyNewVisibleBatch to prove retry- and unique-index idempotency.
 */

// ── Part B mock state (hoisted so the vi.mock factories can capture it) ───────
const h = vi.hoisted(() => ({
  notifications: [] as any[],
  profiles: [] as any[],
  emailCalls: [] as any[],
  raceMiss: false, // when true, the dedupe pre-check SELECT returns empty (simulate concurrent readers both missing)
}))

vi.mock('@/lib/email', () => ({
  sendNewBatchEmail: vi.fn(async (...args: any[]) => { h.emailCalls.push(args) }),
}))

vi.mock('@/lib/supabase/admin', () => {
  function from(table: string) {
    const filters: ((r: any) => boolean)[] = []
    let op: 'select' | 'insert' | 'update' = 'select'
    let payload: any = null
    const b: any = {
      // .insert(...).select().single() must stay an insert — don't let the trailing
      // .select() (used to return the inserted row) reset the operation.
      select(_sel?: any, _opts?: any) { if (op !== 'insert') op = 'select'; return b },
      insert(v: any) { op = 'insert'; payload = v; return b },
      update(v: any) { op = 'update'; payload = v; return b },
      eq(k: string, v: any) {
        if (k === 'data->>dedupeKey') filters.push((r) => (r.data?.dedupeKey ?? null) === v)
        else filters.push((r) => r[k] === v)
        return b
      },
      maybeSingle() { return run().then((x: any) => ({ data: x.data[0] ?? null, error: x.error })) },
      single() { return run().then((x: any) => ({ data: x.data[0] ?? null, error: x.error })) },
      then(res: any, rej: any) { return run().then(res, rej) },
    }
    async function run() {
      const tbl = (h as any)[table] as any[]
      if (op === 'insert') {
        const arr = Array.isArray(payload) ? payload : [payload]
        for (const v of arr) {
          // Partial unique index (notifications_user_type_dedupe_key_uniq) — the DB is
          // the final arbiter even if the pre-check missed. Always enforced on insert.
          if (table === 'notifications' && v.data?.dedupeKey) {
            const dup = tbl.find((r) => r.user_id === v.user_id && r.type === v.type && r.data?.dedupeKey === v.data.dedupeKey)
            if (dup) return { data: [], error: { code: '23505', message: 'duplicate key value' } }
          }
          tbl.push({ id: `n${tbl.length + 1}`, ...v })
        }
        return { data: [tbl[tbl.length - 1]], error: null }
      }
      let m = tbl.filter((r) => filters.every((f) => f(r)))
      if (table === 'notifications' && h.raceMiss) m = [] // simulate the concurrent-read race
      return { data: m.map((r) => ({ ...r })), error: null }
    }
    return b
  }
  return { createAdminClient: () => ({ from, rpc: async () => ({ data: null, error: null }) }) }
})

import { enqueueBatch, promoteIfResolved } from '@/lib/introductions/queue'
import { shouldNotifyVisibleBatch, notifyNewVisibleBatch } from '@/lib/notifications/engagement'

// ── Part A in-memory queue mock (queue-service query surface) ─────────────────
function makeClient(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    recommendation_batches: [...(seed.recommendation_batches ?? [])],
    intro_requests: [...(seed.intro_requests ?? [])],
  }
  function from(table: string) {
    if (!tables[table]) tables[table] = []
    const filters: ((r: any) => boolean)[] = []
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
    let payload: any = null
    const b: any = {
      select() { op = 'select'; return b },
      insert(v: any) { op = 'insert'; payload = v; return b },
      update(v: any) { op = 'update'; payload = v; return b },
      delete() { op = 'delete'; return b },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b },
      in(k: string, arr: any[]) { const s = new Set(arr); filters.push((r) => s.has(r[k])); return b },
      order() { return b },
      limit() { return b },
      maybeSingle() { return run().then((x: any) => ({ data: x.data[0] ?? null, error: null })) },
      single() { return run().then((x: any) => ({ data: x.data[0] ?? null, error: null })) },
      then(res: any, rej: any) { return run().then(res, rej) },
    }
    const matched = () => tables[table].filter((r) => filters.every((f) => f(r)))
    async function run() {
      if (op === 'insert') {
        const arr = Array.isArray(payload) ? payload : [payload]
        for (const v of arr) tables[table].push({ ...v })
        return { data: null, error: null }
      }
      const m = matched()
      if (op === 'update') { for (const r of m) Object.assign(r, payload); return { data: null, error: null } }
      if (op === 'delete') { tables[table] = tables[table].filter((r) => !filters.every((f) => f(r))); return { data: null, error: null } }
      return { data: m.map((r) => ({ ...r })), error: null }
    }
    return b
  }
  return { from, __tables: tables } as any
}

const adminRows = (targets: string[]) => targets.map((t) => ({ target_user_id: t, match_reason: null }))

// ==============================================================================
// Part A — placement → gating → dedupe key (real enqueueBatch / promoteIfResolved)
// ==============================================================================
describe('admin reciprocal placement → visibility gate → dedupe key', () => {
  it('Test 1 — placed ACTIVE (empty slot) → announce, dedupeKey batch:<batchId>', async () => {
    const c = makeClient()
    const result = await enqueueBatch(c, { memberId: 'M', source: 'admin_reciprocal', rows: adminRows(['b', 'ca']) })

    expect(result.placed).toBe(true)
    expect(result.state).toBe('active')
    expect(result.batchId).toBeTruthy()
    // This is the exact predicate the route uses before calling notifyNewVisibleBatch.
    expect(shouldNotifyVisibleBatch(result)).toBe(true)
    expect(`batch:${result.batchId}`).toMatch(/^batch:[0-9a-f-]{36}$/)
  })

  it('Test 2 — placed QUEUED (active occupied) → silent, no announce', async () => {
    const c = makeClient()
    // First admin batch takes the active slot.
    await enqueueBatch(c, { memberId: 'M', source: 'admin_reciprocal', rows: adminRows(['b', 'ca']) })
    // Second admin-style batch (organic here) is forced into the QUEUED slot.
    const queued = await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: adminRows(['d', 'e']) })

    expect(queued.placed).toBe(true)
    expect(queued.state).toBe('queued')
    // The route must NOT announce a hidden queued batch.
    expect(shouldNotifyVisibleBatch(queued)).toBe(false)
  })

  it('Test 3 — queued admin batch later PROMOTED → announced once, key batch:<promotedId>', async () => {
    const c = makeClient()
    const active = await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: adminRows(['b', 'ca']) })
    const adminQueued = await enqueueBatch(c, { memberId: 'M', source: 'admin_reciprocal', rows: adminRows(['d', 'e']) })
    expect(adminQueued.state).toBe('queued')
    expect(shouldNotifyVisibleBatch(adminQueued)).toBe(false) // silent while hidden

    // Resolve the active batch fully (pass on both suggested rows), then promote.
    for (const r of c.__tables.intro_requests.filter((x: any) => x.batch_id === active.batchId)) r.status = 'passed'
    const promo = await promoteIfResolved(c, 'M')

    expect(promo.promoted).toBe(true)
    // The promoted (now-visible) batch is exactly the admin batch — announced now, once.
    expect(promo.newActive).toBe(adminQueued.batchId)
    // The promotion path and the (skipped) approval path share the SAME stable key.
    expect(`batch:${promo.newActive}`).toBe(`batch:${adminQueued.batchId}`)
  })

  it('Test 6 — organic flows unchanged: weekly/onboarding active announce, queued silent, promotion announces', async () => {
    // Onboarding / weekly active placement → announce.
    const onboarding = await enqueueBatch(makeClient(), { memberId: 'M', source: 'onboarding', rows: adminRows(['b', 'ca']) })
    expect(onboarding.state).toBe('active')
    expect(shouldNotifyVisibleBatch(onboarding)).toBe(true)

    // Organic queued batch stays silent.
    const c = makeClient()
    await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: adminRows(['b', 'ca']) })
    const organicQueued = await enqueueBatch(c, { memberId: 'M', source: 'weekly', rows: adminRows(['d', 'e']) })
    expect(organicQueued.state).toBe('queued')
    expect(shouldNotifyVisibleBatch(organicQueued)).toBe(false)

    // Promotion of the organic queued batch announces (unchanged behavior).
    for (const r of c.__tables.intro_requests.filter((x: any) => x.status === 'suggested')) r.status = 'passed'
    const promo = await promoteIfResolved(c, 'M')
    expect(promo.promoted).toBe(true)
    expect(promo.newActive).toBe(organicQueued.batchId)
  })
})

// ==============================================================================
// Part B — notifyNewVisibleBatch idempotency (real helper, mocked admin client)
// ==============================================================================
describe('notifyNewVisibleBatch — one notification + one email per batch', () => {
  const OLD_RESEND = process.env.RESEND_API_KEY

  beforeEach(() => {
    h.notifications.length = 0
    h.profiles.length = 0
    h.emailCalls.length = 0
    h.raceMiss = false
    h.profiles.push({ id: 'M', email: 'm@example.com', full_name: 'Member' })
    process.env.RESEND_API_KEY = 'test-key' // gate the email send ON
  })
  afterEach(() => { process.env.RESEND_API_KEY = OLD_RESEND })

  it('Test 1 (helper) — active admin batch → one new_batch notification + one email, key batch:<id>', async () => {
    await notifyNewVisibleBatch('M', 'B-1', 2)

    expect(h.notifications).toHaveLength(1)
    expect(h.notifications[0]).toMatchObject({ user_id: 'M', type: 'new_batch' })
    expect(h.notifications[0].data.dedupeKey).toBe('batch:B-1')
    expect(h.emailCalls).toHaveLength(1)
    expect(h.emailCalls[0]).toEqual(['m@example.com', 'Member', 2])
  })

  it('Test 4 — retry for the same batch → no second notification, no second email', async () => {
    await notifyNewVisibleBatch('M', 'B-1', 2) // approval/first delivery
    await notifyNewVisibleBatch('M', 'B-1', 2) // promotion / retry / duplicate worker

    expect(h.notifications).toHaveLength(1)
    expect(h.emailCalls).toHaveLength(1)
  })

  it('Test 5 — concurrent race (pre-check misses) → unique index blocks the 2nd, still one email', async () => {
    await notifyNewVisibleBatch('M', 'B-1', 2) // first worker wins
    expect(h.emailCalls).toHaveLength(1)

    // Simulate the second worker whose dedupe SELECT raced and returned empty.
    h.raceMiss = true
    await notifyNewVisibleBatch('M', 'B-1', 2)

    // The partial unique index rejects the duplicate insert (23505); createNotificationSafe
    // treats it as an idempotent no-op → notifyNewVisibleBatch never reaches the email.
    expect(h.notifications).toHaveLength(1)
    expect(h.emailCalls).toHaveLength(1)
  })

  it('distinct batches each notify once (no cross-batch suppression)', async () => {
    await notifyNewVisibleBatch('M', 'B-1', 2)
    await notifyNewVisibleBatch('M', 'B-2', 3)

    expect(h.notifications.map((n) => n.data.dedupeKey).sort()).toEqual(['batch:B-1', 'batch:B-2'])
    expect(h.emailCalls).toHaveLength(2)
  })
})
