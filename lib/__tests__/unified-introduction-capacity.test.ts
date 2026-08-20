import { describe, it, expect, vi } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { enqueueBatch, promoteIfResolved } from '@/lib/introductions/queue'
import { attachQueueRpc } from './helpers/queueRpcModel'
import {
  MAX_VISIBLE_INTRO_CARDS, MAX_RESERVED_INTRO_CARDS, VISIBLE_STATUS, RESERVED_STATUS,
  visibleSlotsFree, reservedSlotsFree, hasVisibleCapacity,
} from '@/lib/introductions/capacity'

/**
 * UNIFIED INTRODUCTION CAPACITY.
 *
 * WHAT WAS WRONG. A member's capacity was decided in three places that did not agree:
 * create_reciprocal_suggestion counted 'suggested' + 'queued' against one cap of 2; the queue
 * service decided placement from the EXISTENCE of a recommendation_batches row and never counted
 * intro_requests at all; the introductions page sliced the rendered list to 2. Reciprocal cards are
 * created with batch_id NULL by design (migration 050 step 8), so a member holding only reciprocal
 * cards had no batch row, looked empty, and received two more VISIBLE cards on top of them. Measured
 * on production: 4 members holding three 'suggested' rows, of which the UI showed two — hiding the
 * oldest, typically the reciprocal card, which silently broke the two-sided guarantee.
 *
 * HOW THIS FILE IS SPLIT, and what each half can honestly prove:
 *
 *   • SQL TEXT assertions pin the enforcement that only the database can perform — the advisory
 *     lock, the ordering of lock-then-count, SECURITY DEFINER, search_path, and the grants.
 *   • BEHAVIOURAL assertions drive the real enqueueBatch/promoteIfResolved against an in-memory
 *     transcription of the SQL (helpers/queueRpcModel).
 *
 * A model of a lock is not a lock. No test in this file proves two concurrent transactions
 * serialize; that is provable only against a real Postgres, and the final describe block states
 * exactly that rather than implying coverage this suite does not have.
 */

const SQL = readFileSync('supabase/migrations/063_unified_introduction_capacity.sql', 'utf8')
const QUEUE = readFileSync('lib/introductions/queue.ts', 'utf8')

const fn = (name: string) => {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  expect(start, `${name} missing from migration 063`).toBeGreaterThan(-1)
  const end = SQL.indexOf('$$;', start)
  return SQL.slice(start, end)
}

// Real uuids, because the RPC casts target_user_id to uuid and screens the payload for it.
const ids = new Map<string, string>()
const U = (label: string) => {
  if (!ids.has(label)) ids.set(label, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`)
  return ids.get(label) as string
}
const M = U('member')

function client(seed: { intro_requests?: any[]; recommendation_batches?: any[] } = {}) {
  return attachQueueRpc({
    __tables: {
      intro_requests: [...(seed.intro_requests ?? [])],
      recommendation_batches: [...(seed.recommendation_batches ?? [])],
    },
  } as any, { strictUuid: true })
}
const card = (status: string, target: string, extra: Record<string, unknown> = {}) => ({
  id: `ir-${target}-${status}`, requester_id: M, target_user_id: U(target), status,
  batch_id: null, pair_id: null, created_at: '2026-01-01T00:00:00Z', ...extra,
})
const rows = (...targets: string[]) => targets.map((t) => ({ target_user_id: U(t), match_reason: null }))
const visible = (c: any) => c.__tables.intro_requests.filter((r: any) => r.requester_id === M && r.status === 'suggested')
const reserved = (c: any) => c.__tables.intro_requests.filter((r: any) => r.requester_id === M && r.status === 'queued')

// ── 1. The contract ──────────────────────────────────────────────────────────────────────────────

describe('1. capacity is TWO independent tiers', () => {
  it('names each tier by the status it is made of, with its own cap', () => {
    expect(VISIBLE_STATUS).toBe('suggested')
    expect(RESERVED_STATUS).toBe('queued')
    expect(MAX_VISIBLE_INTRO_CARDS).toBe(2)
    expect(MAX_RESERVED_INTRO_CARDS).toBe(2)
  })

  it('a reserved card never consumes a visible slot, and vice versa', () => {
    expect(visibleSlotsFree({ visible: 0, reserved: 2 })).toBe(2)
    expect(reservedSlotsFree({ visible: 2, reserved: 0 })).toBe(2)
    expect(hasVisibleCapacity({ visible: 0, reserved: 2 })).toBe(true)   // THE approved decision
    expect(hasVisibleCapacity({ visible: 2, reserved: 0 })).toBe(false)
  })

  it('is defensive about counts that are already over the cap or malformed', () => {
    expect(visibleSlotsFree({ visible: 5, reserved: 0 })).toBe(0)        // over-capacity → 0, never negative
    expect(reservedSlotsFree({ visible: 0, reserved: -3 })).toBe(2)
  })
})

// ── 2. What the database enforces ────────────────────────────────────────────────────────────────

describe('2. every capacity RPC is hardened the same way', () => {
  const NAMES = ['create_reciprocal_suggestion', 'place_batch_rows', 'promote_queued_rows']

  it('all three are SECURITY DEFINER with a pinned empty search_path', () => {
    for (const n of NAMES) {
      expect(fn(n), n).toMatch(/SECURITY DEFINER/)
      expect(fn(n), n).toMatch(/SET search_path = ''/)
    }
  })

  it('all three are revoked from PUBLIC/anon/authenticated and granted only to service_role', () => {
    for (const n of NAMES) {
      expect(SQL, n).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${n}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`))
      expect(SQL, n).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${n}\\([^)]*\\) TO service_role;`))
    }
    expect(SQL).not.toMatch(/GRANT[^;]*TO (anon|authenticated)/)
  })

  it('every table reference is schema-qualified — search_path = \'\' resolves nothing otherwise', () => {
    for (const n of NAMES) {
      for (const t of ['intro_requests', 'recommendation_batches', 'member_pairs', 'profiles', 'matches', 'blocked_users']) {
        const bare = new RegExp(`(FROM|JOIN|INTO|UPDATE)\\s+${t}\\b`, 'i')
        expect(fn(n), `${n} references bare ${t}`).not.toMatch(bare)
      }
    }
  })

  it('creates no temp table — it would not resolve under an empty search_path', () => {
    expect(SQL).not.toMatch(/CREATE\s+TEMP/i)
  })
})

describe('3. the member lock is taken BEFORE anything is counted', () => {
  const LOCK = /pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(/

  it('place_batch_rows and promote_queued_rows each lock the member', () => {
    for (const n of ['place_batch_rows', 'promote_queued_rows']) {
      expect(fn(n), n).toMatch(LOCK)
      expect(fn(n), n).toMatch(/hashtextextended\(p_member_id::text, 0\)/)
    }
  })

  it('create_reciprocal_suggestion locks BOTH participants in canonical order', () => {
    const f = fn('create_reciprocal_suggestion')
    expect(f).toMatch(/hashtextextended\(lo::text, 0\)/)
    expect(f).toMatch(/hashtextextended\(hi::text, 0\)/)
    // lo before hi — the ordering is what makes two overlapping pairs deadlock-free.
    expect(f.indexOf('lo::text')).toBeLessThan(f.indexOf('hi::text'))
  })

  it('the lock precedes the first count in every function — not the other way round', () => {
    for (const n of ['create_reciprocal_suggestion', 'place_batch_rows', 'promote_queued_rows']) {
      const f = fn(n)
      const lock = f.search(LOCK)
      const count = f.search(/SELECT count\(\*\)/)
      expect(lock, `${n}: no lock`).toBeGreaterThan(-1)
      expect(count, `${n}: no count`).toBeGreaterThan(-1)
      expect(lock, `${n}: counts before locking`).toBeLessThan(count)
    }
  })

  it('all three hash the SAME key space, so they serialize against each other', () => {
    // A reciprocal creation for M and a batch placement for M must contend on one lock.
    const keys = ['create_reciprocal_suggestion', 'place_batch_rows', 'promote_queued_rows']
      .map((n) => (fn(n).match(/pg_catalog\.hashtextextended\((\w+(?:::text)?), 0\)/g) ?? []).length)
    expect(keys).toEqual([2, 1, 1])
  })
})

describe('4. capacity is decided by STATUS, never by batch_id or pair_id', () => {
  it('create_reciprocal_suggestion counts the VISIBLE tier only', () => {
    const f = fn('create_reciprocal_suggestion')
    expect(f).toMatch(/ir\.requester_id = a_id AND ir\.status = 'suggested'/)
    expect(f).toMatch(/ir\.requester_id = b_id AND ir\.status = 'suggested'/)
    // the migration-050 formulation must be gone from the capacity step
    expect(f).not.toMatch(/requester_id = a_id AND ir\.status IN \('suggested','queued'\)/)
  })

  it('place_batch_rows counts intro_requests, not recommendation_batches', () => {
    const f = fn('place_batch_rows')
    expect(f).toMatch(/count\(\*\) FILTER \(WHERE ir\.status = 'suggested'\)/)
    expect(f).toMatch(/count\(\*\) FILTER \(WHERE ir\.status = 'queued'\)/)
    expect(f).toMatch(/FROM public\.intro_requests ir\s+WHERE ir\.requester_id = p_member_id/)
  })

  it('neither counting query filters on batch_id or pair_id', () => {
    const f = fn('place_batch_rows')
    const counting = f.slice(f.indexOf("count(*) FILTER"), f.indexOf('SELECT * INTO v_active'))
    expect(counting).not.toMatch(/batch_id|pair_id/)
  })

  it('promote_queued_rows RE-COUNTS visible AFTER completing the active batch', () => {
    const f = fn('promote_queued_rows')
    const complete = f.indexOf("state = 'completed'")
    const recount = f.indexOf("SELECT count(*) INTO v_visible")
    expect(complete).toBeGreaterThan(-1)
    expect(recount).toBeGreaterThan(complete) // else pair-governed reciprocal cards are missed
  })

  it('promotion flips the batch ACTIVE before inserting the split queued batch', () => {
    // Reversed, the one-queued-per-member partial-unique index rejects the insert.
    const f = fn('promote_queued_rows')
    expect(f.indexOf("SET state = 'active', displayed_at = v_now"))
      .toBeLessThan(f.indexOf('INSERT INTO public.recommendation_batches'))
  })
})

// ── 5. Behaviour, through the real client ────────────────────────────────────────────────────────

describe('5. one call fills VISIBLE first, then RESERVED, and drops only the rest', () => {
  it('THE REGRESSION: a member holding one reciprocal card gets 1 visible + 1 RESERVED, not 3 visible', async () => {
    // Exactly the production shape: a live reciprocal card, batch_id NULL, so no batch row exists.
    const c = client({ intro_requests: [card('suggested', 'recip', { pair_id: 'p1' })] })
    const r = await enqueueBatch(c, { memberId: M, source: 'weekly', rows: rows('a', 'b') })

    expect(r.placed).toBe(true)
    expect(r.visiblePlaced).toBe(1)          // the one free visible slot
    expect(r.reservedPlaced).toBe(1)         // the surplus is RESERVED, not thrown away
    expect(r.dropped).toBe(0)
    expect(visible(c)).toHaveLength(MAX_VISIBLE_INTRO_CARDS)
    expect(reserved(c)).toHaveLength(1)
  })

  it('an empty member takes 2 visible + 2 reserved from a 4-candidate payload', async () => {
    const c = client()
    const r = await enqueueBatch(c, { memberId: M, source: 'weekly', rows: rows('a', 'b', 'c', 'd') })
    expect([r.visiblePlaced, r.reservedPlaced, r.dropped]).toEqual([2, 2, 0])
    expect(visible(c)).toHaveLength(2)
    expect(reserved(c)).toHaveLength(2)
    // one batch of each state, never two of either
    const b = c.__tables.recommendation_batches
    expect(b.filter((x: any) => x.state === 'active')).toHaveLength(1)
    expect(b.filter((x: any) => x.state === 'queued')).toHaveLength(1)
  })

  it('2 visible / 1 reserved + 2 candidates → 1 reserved + 1 dropped', async () => {
    const c = client({
      intro_requests: [card('suggested', 'r1'), card('suggested', 'r2'), card('queued', 'q1', { batch_id: 'Q' })],
      recommendation_batches: [{ batch_id: 'Q', member_id: M, batch_source: 'weekly', state: 'queued' }],
    })
    const r = await enqueueBatch(c, { memberId: M, source: 'weekly', rows: rows('a', 'b') })
    expect([r.visiblePlaced, r.reservedPlaced, r.dropped]).toEqual([0, 1, 1])
    expect(visible(c)).toHaveLength(2)       // untouched
    expect(reserved(c)).toHaveLength(MAX_RESERVED_INTRO_CARDS)
  })

  it('both tiers full → refuses, and nothing at all is written', async () => {
    const c = client({
      intro_requests: [
        card('suggested', 'r1'), card('suggested', 'r2'),
        card('queued', 'q1'), card('queued', 'q2'),
      ],
    })
    const before = JSON.stringify(c.__tables)
    const r = await enqueueBatch(c, { memberId: M, source: 'weekly', rows: rows('a', 'b') })
    expect(r.placed).toBe(false)
    expect(r.reason).toBe('at_capacity')
    expect(r.dropped).toBe(2)
    expect(JSON.stringify(c.__tables)).toBe(before)
  })

  it('appends into the member\'s existing batch rather than creating a second one', async () => {
    const c = client({
      intro_requests: [card('suggested', 'x', { batch_id: 'A' })],
      recommendation_batches: [{ batch_id: 'A', member_id: M, batch_source: 'weekly', state: 'active' }],
    })
    const r = await enqueueBatch(c, { memberId: M, source: 'weekly', rows: rows('a') })
    expect(r.visiblePlaced).toBe(1)
    expect(r.activeBatchId).toBe('A')
    expect(c.__tables.recommendation_batches.filter((b: any) => b.state === 'active')).toHaveLength(1)
  })

  it('still dedupes a target the member already holds, before spending a slot on it', async () => {
    const c = client({ intro_requests: [card('pending', 'a')] })
    const r = await enqueueBatch(c, { memberId: M, source: 'weekly', rows: rows('a', 'b') })
    expect(r.visiblePlaced).toBe(1)
    expect(visible(c).map((x: any) => x.target_user_id)).toEqual([U('b')])
  })

  it('never places a self-pair', async () => {
    const c = client()
    const r = await enqueueBatch(c, { memberId: M, source: 'weekly', rows: [{ target_user_id: M }, ...rows('b')] })
    expect(visible(c).map((x: any) => x.target_user_id)).toEqual([U('b')])
    expect(r.visiblePlaced).toBe(1)
  })
})

describe('6. promotion reveals only what fits', () => {
  const withQueuedBatch = () => client({
    recommendation_batches: [
      { batch_id: 'A', member_id: M, batch_source: 'weekly', state: 'active', created_at: 't0', generated_at: 't0' },
      { batch_id: 'Q', member_id: M, batch_source: 'weekly', state: 'queued', created_at: 't1', generated_at: 't1' },
    ],
    intro_requests: [
      card('suggested', 'a1', { batch_id: 'A' }), card('approved', 'a1x', { target_user_id: U('a1') } as any),
      card('queued', 'q1', { batch_id: 'Q', created_at: '2026-01-01T00:00:00Z' }),
      card('queued', 'q2', { batch_id: 'Q', created_at: '2026-01-02T00:00:00Z' }),
    ],
  })

  it('THE REGRESSION: a surviving reciprocal card limits the reveal to the free slot', async () => {
    const c = withQueuedBatch()
    // A live reciprocal card the member already acted on — pair-governed, so the batch-scoped
    // archive deliberately leaves it in place and it still occupies a visible slot.
    c.__tables.intro_requests.push(card('suggested', 'recip', { pair_id: 'p1', batch_id: null }))
    c.__tables.intro_requests.push({ ...card('approved', 'recip-i'), target_user_id: U('recip') })

    const r = await promoteIfResolved(c, M)
    expect(r.promoted).toBe(true)
    expect(visible(c)).toHaveLength(MAX_VISIBLE_INTRO_CARDS)   // was 3 before the fix
    expect(reserved(c)).toHaveLength(1)                        // the leftover stays reserved
  })

  it('splits the un-revealed remainder into a fresh queued batch, keeping one batch per state', async () => {
    const c = withQueuedBatch()
    c.__tables.intro_requests.push(card('suggested', 'recip', { pair_id: 'p1' }))
    c.__tables.intro_requests.push({ ...card('approved', 'recip-i'), target_user_id: U('recip') })

    await promoteIfResolved(c, M)
    const b = c.__tables.recommendation_batches.filter((x: any) => x.member_id === M)
    expect(b.filter((x: any) => x.state === 'active')).toHaveLength(1)
    expect(b.filter((x: any) => x.state === 'queued')).toHaveLength(1)
    // the leftover row moved to the NEW queued batch, so no batch mixes statuses
    const q = b.find((x: any) => x.state === 'queued')
    expect(reserved(c).every((r: any) => r.batch_id === q.batch_id)).toBe(true)
  })

  it('reveals the oldest reservation first', async () => {
    const c = withQueuedBatch()
    c.__tables.intro_requests.push(card('suggested', 'recip', { pair_id: 'p1' }))
    c.__tables.intro_requests.push({ ...card('approved', 'recip-i'), target_user_id: U('recip') })
    await promoteIfResolved(c, M)
    expect(visible(c).map((x: any) => x.target_user_id)).toContain(U('q1'))
    expect(reserved(c).map((x: any) => x.target_user_id)).toEqual([U('q2')])
  })

  it('defers instead of discarding when no visible slot is free, and promotes on a later call', async () => {
    const c = withQueuedBatch()
    // TWO live reciprocal cards: the screen is full even after the active batch completes.
    for (const t of ['r1', 'r2']) {
      c.__tables.intro_requests.push(card('suggested', t, { pair_id: `p-${t}` }))
      c.__tables.intro_requests.push({ ...card('approved', `${t}-i`), target_user_id: U(t) })
    }
    const first = await promoteIfResolved(c, M)
    expect(first.promoted).toBe(false)
    expect(first.reason).toBe('deferred_capacity')
    expect(reserved(c)).toHaveLength(2)                        // nothing discarded

    // the member resolves both reciprocal cards
    for (const r of c.__tables.intro_requests) if (r.status === 'suggested') r.status = 'passed'
    const second = await promoteIfResolved(c, M)
    expect(second.promoted).toBe(true)                         // self-healing without an active batch
    expect(visible(c)).toHaveLength(2)
  })

  it('does not promote while any introduction is still unresolved', async () => {
    const c = withQueuedBatch()
    c.__tables.intro_requests = c.__tables.intro_requests.filter((r: any) => r.status !== 'approved')
    const r = await promoteIfResolved(c, M)
    expect(r.promoted).toBe(false)
    expect(r.reason).toBe('incomplete')
    expect(reserved(c)).toHaveLength(2)
  })
})

// ── 7. The client fails safely ───────────────────────────────────────────────────────────────────

describe('7. the TypeScript client never becomes a second, unlocked write path', () => {
  it('queue.ts no longer inserts or updates recommendation rows itself', () => {
    expect(QUEUE).not.toMatch(/from\('intro_requests'\)[\s\S]{0,80}\.(insert|delete)\(/)
    expect(QUEUE).not.toMatch(/from\('recommendation_batches'\)[\s\S]{0,80}\.(insert|update|delete)\(/)
    expect(QUEUE).not.toMatch(/randomUUID/)          // batch ids are minted in the transaction now
    expect(QUEUE).toMatch(/rpc\('place_batch_rows'/)
    expect(QUEUE).toMatch(/rpc\('promote_queued_rows'/)
  })

  it('a failed placement THROWS rather than falling back to an unlocked path', async () => {
    const c = { rpc: async () => ({ data: null, error: { code: '42501' } }) } as any
    await expect(enqueueBatch(c, { memberId: M, source: 'weekly', rows: rows('a') })).rejects.toThrow(/place_batch_rows failed/)
  })

  it('an empty request is refused before any round trip', async () => {
    let called = false
    const c = { rpc: async () => { called = true; return { data: null, error: null } } } as any
    expect((await enqueueBatch(c, { memberId: M, source: 'weekly', rows: [] })).reason).toBe('empty')
    expect(called).toBe(false)
  })

  it('a failed promotion is non-fatal and logs only an error class — no identifiers, no raw message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const c = { rpc: async () => ({ data: null, error: { code: '57014', message: 'timeout for member abc@example.com' } }) } as any
    const r = await promoteIfResolved(c, 'member-uuid-1234')
    expect(r.promoted).toBe(false)
    const logged = JSON.stringify(spy.mock.calls)
    expect(logged).toContain('57014')
    expect(logged).not.toContain('abc@example.com')
    expect(logged).not.toContain('member-uuid-1234')
    expect(logged).not.toContain('timeout for member')
    spy.mockRestore()
  })

  it('cannot pass a cap at all — the limits live only in the database', () => {
    // Stronger than "passes the right number": there is NO capacity argument to pass.
    expect(QUEUE).not.toMatch(/p_max_visible|p_max_reserved|p_max_cards/)
    for (const c of ['c_max_visible constant integer := 2', 'c_max_reserved constant integer := 2']) {
      expect(SQL).toContain(c)
    }
    expect(MAX_VISIBLE_INTRO_CARDS).toBe(2)   // the TS mirror must agree with the SQL constants
    expect(MAX_RESERVED_INTRO_CARDS).toBe(2)
  })
})

// ── 5b. Nothing is ever evicted ──────────────────────────────────────────────────────────────────

describe('5b. NOTHING IS EVER EVICTED — literally, not aspirationally', () => {
  it('the SQL contains no DELETE and no discard, in any function', () => {
    for (const n of ['create_reciprocal_suggestion', 'place_batch_rows', 'promote_queued_rows']) {
      expect(fn(n), `${n} deletes rows`).not.toMatch(/\bDELETE\s+FROM\b/i)
      expect(fn(n), `${n} discards a batch`).not.toMatch(/'discarded'/)
    }
    expect(SQL).not.toMatch(/\bDELETE\s+FROM\b/i)
  })

  it('the queue client has no discard path either', () => {
    // The BatchState union still LISTS 'discarded' because historical rows carry it and the column
    // CHECK still permits it — reading it is fine. What must not exist is any code that writes it.
    expect(QUEUE).not.toMatch(/discardQueuedBatch\s*\(/)
    expect(QUEUE).not.toMatch(/discardedQueued/)
    expect(QUEUE).not.toMatch(/state:\s*'discarded'|update\([^)]*'discarded'/)
  })

  it('an admin source gets no precedence over capacity', () => {
    // 'admin_reciprocal' may still appear in the allowed-source list; what must be gone is any
    // COMPARISON that treats it specially — that branch was the eviction.
    const f = fn('place_batch_rows')
    expect(f).toMatch(/p_source NOT IN \('onboarding','weekly','admin_reciprocal','migration'\)/)
    expect(f).not.toMatch(/p_source\s*(<>|=)\s*'admin_reciprocal'/)
    expect(f).not.toMatch(/batch_source\s*=\s*'admin_reciprocal'/)
  })

  it('a refused placement leaves every existing row and batch byte-for-byte unchanged', async () => {
    for (const source of ['weekly', 'admin_reciprocal', 'onboarding', 'migration'] as const) {
      const c = client({
        intro_requests: [
          card('suggested', 'r1'), card('suggested', 'r2'),
          card('queued', 'q1', { batch_id: 'Q' }), card('queued', 'q2', { batch_id: 'Q' }),
        ],
        recommendation_batches: [{ batch_id: 'Q', member_id: M, batch_source: 'weekly', state: 'queued' }],
      })
      const before = JSON.stringify(c.__tables)
      const r = await enqueueBatch(c, { memberId: M, source, rows: rows('new1', 'new2') })
      expect(r.placed, source).toBe(false)
      expect(JSON.stringify(c.__tables), source).toBe(before)
    }
  })

  it('promotion never deletes: a deferred reservation survives untouched', async () => {
    const c = client({
      recommendation_batches: [{ batch_id: 'Q', member_id: M, batch_source: 'weekly', state: 'queued' }],
      intro_requests: [
        card('suggested', 'r1', { pair_id: 'p1' }), card('suggested', 'r2', { pair_id: 'p2' }),
        card('queued', 'q1', { batch_id: 'Q' }), card('queued', 'q2', { batch_id: 'Q' }),
      ],
    })
    const r = await promoteIfResolved(c, M)
    expect(r.promoted).toBe(false)
    // Two live reciprocal cards fill the visible tier, so there is nothing to reveal into. The
    // reservation is DEFERRED, not dropped — and promotion no longer needs an active batch to run,
    // so a later call reveals it once a visible slot frees.
    expect(r.reason).toBe('deferred_capacity')
    expect(reserved(c)).toHaveLength(2)     // still there, still queued
  })
})

// ── 7b. Hostile and malformed input ──────────────────────────────────────────────────────────────

describe('7b. a malicious or buggy service-role caller cannot exceed either cap', () => {
  it('there is no capacity parameter on either new RPC — the caps are SQL constants', () => {
    const place = fn('place_batch_rows')
    const promote = fn('promote_queued_rows')
    // signature ends at the first ")" before RETURNS
    const sig = (f: string) => f.slice(0, f.indexOf('RETURNS'))
    expect(sig(place)).not.toMatch(/p_max|p_cap|p_limit/)
    expect(sig(promote)).not.toMatch(/p_max|p_cap|p_limit/)
    expect(place).toMatch(/c_max_visible\s+constant integer := 2/)
    expect(place).toMatch(/c_max_reserved\s+constant integer := 2/)
    expect(promote).toMatch(/c_max_visible constant integer := 2/)
  })

  it('create_reciprocal_suggestion clamps p_max_cards >= 1 and FAILS CLOSED on NULL/0/negative', () => {
    const f = fn('create_reciprocal_suggestion')
    expect(f).toMatch(/c_max_visible constant integer := 2/)
    // NULL / 0 / negative are refused BEFORE any lock or write. An earlier draft coalesced them up
    // to the full cap of 2 — the wrong direction: a caller that had lost track of its own limit
    // would have been handed the maximum.
    expect(f).toMatch(/IF p_max_cards IS NULL OR p_max_cards < 1 THEN\s*\n\s*RETURN 'invalid';/)
    // and the refusal precedes the advisory locks
    expect(f.indexOf('p_max_cards < 1')).toBeLessThan(f.indexOf('pg_advisory_xact_lock'))
    // >= 1 is clamped downward: 100 behaves exactly as 2
    expect(f).toMatch(/max_cards := LEAST\(p_max_cards, c_max_visible\)/)
    expect(f).toMatch(/IF a_cards >= max_cards OR b_cards >= max_cards THEN/)
    expect(f).not.toMatch(/>= p_max_cards/)          // the raw argument is never compared against
  })

  it('the application never sends a capacity argument it could get wrong', () => {
    const RECIP = readFileSync('lib/matching/createReciprocalSuggestion.ts', 'utf8')
    expect(RECIP).not.toMatch(/maxCards\?:/)         // the option is gone from the public signature
    expect(RECIP).toMatch(/p_max_cards: MAX_VISIBLE_INTRO_CARDS/)
  })

  it('an oversized payload is refused outright, not silently truncated to a prefix', async () => {
    const c = client()
    const many = Array.from({ length: 51 }, (_, i) => ({ target_user_id: U(`bulk${i}`), match_reason: null }))
    const r = await enqueueBatch(c, { memberId: M, source: 'weekly', rows: many })
    expect(r.placed).toBe(false)
    expect(r.reason).toBe('too_many_rows')
    expect(c.__tables.intro_requests).toHaveLength(0)
    expect(c.__tables.recommendation_batches).toHaveLength(0)
  })

  it('a payload of 50 identical targets places exactly one card, never fifty', async () => {
    const c = client()
    const dupes = Array.from({ length: 50 }, () => ({ target_user_id: U('same'), match_reason: null }))
    const r = await enqueueBatch(c, { memberId: M, source: 'weekly', rows: dupes })
    expect(r.visiblePlaced).toBe(1)
    expect(r.reservedPlaced).toBe(0)
    expect(r.dropped).toBe(49)
    expect(visible(c)).toHaveLength(1)
  })

  it('duplicate targets deduplicate deterministically — first occurrence wins', async () => {
    const c = client()
    await enqueueBatch(c, {
      memberId: M, source: 'weekly',
      rows: [
        { target_user_id: U('x'), match_reason: 'first' },
        { target_user_id: U('x'), match_reason: 'second' },
        { target_user_id: U('y'), match_reason: 'y' },
      ],
    })
    expect(visible(c).map((r: any) => r.match_reason)).toEqual(['first', 'y'])
  })

  it('malformed and self targets are dropped, and the valid remainder still places', async () => {
    const c = client()
    const r = await enqueueBatch(c, {
      memberId: M, source: 'weekly',
      rows: [
        { target_user_id: 'not-a-uuid' } as any,
        { target_user_id: '' } as any,
        { target_user_id: M },                 // self
        { target_user_id: U('ok') },
      ],
    })
    expect(r.visiblePlaced).toBe(1)
    expect(visible(c).map((x: any) => x.target_user_id)).toEqual([U('ok')])
  })

  it('a null member, an unknown source and a non-array payload all fail closed with no writes', async () => {
    for (const args of [
      { memberId: null as any, source: 'weekly' as any, rows: rows('a') },
      { memberId: M, source: 'not_a_source' as any, rows: rows('a') },
      { memberId: M, source: 'weekly' as any, rows: 'oops' as any },
    ]) {
      const c = client()
      const r = await enqueueBatch(c, args)
      expect(r.placed).toBe(false)
      expect(r.reason).toBe('invalid')
      expect(c.__tables.intro_requests).toHaveLength(0)
      expect(c.__tables.recommendation_batches).toHaveLength(0)
    }
  })

  it('EVERY refusal happens before the first write — no discarded, empty or half-placed batch', () => {
    // Structural proof in the SQL: the writes are contiguous and last. Nothing between the "writes"
    // marker and the end returns without placing.
    const f = fn('place_batch_rows')
    const firstWrite = Math.min(
      ...['DELETE FROM public.intro_requests', 'INSERT INTO public.recommendation_batches']
        .map((k) => f.indexOf(k)).filter((i) => i > -1))
    const refusals = Array.from(f.matchAll(/RETURN jsonb_build_object\('placed', false/g)).map((m) => m.index as number)
    expect(refusals.length).toBeGreaterThan(6)
    for (const at of refusals) expect(at, 'a refusal returns after a write').toBeLessThan(firstWrite)
  })

  it('an admin batch that cannot fit does NOT destroy the organic queued batch it would displace', async () => {
    // capacity is computed as if the discard had happened, so the refusal precedes the delete
    const c = client({
      recommendation_batches: [
        { batch_id: 'A', member_id: M, batch_source: 'weekly', state: 'active' },
        { batch_id: 'Q', member_id: M, batch_source: 'weekly', state: 'queued' },
      ],
      intro_requests: [
        card('queued', 'strayA', { batch_id: 'other' }), card('queued', 'strayB', { batch_id: 'other' }),
        card('queued', 'organic', { batch_id: 'Q' }),
      ],
    })
    const r = await enqueueBatch(c, { memberId: M, source: 'admin_reciprocal', rows: rows('new1') })
    expect(r.placed).toBe(false)
    expect(r.reason).toBe('reserved_full')
    // the organic batch and its row survive untouched
    expect(c.__tables.recommendation_batches.find((b: any) => b.batch_id === 'Q').state).toBe('queued')
    expect(reserved(c)).toHaveLength(3)
  })

  it('inconsistent batch metadata is reported, never acted on', async () => {
    const c = client({
      recommendation_batches: [
        { batch_id: 'A1', member_id: M, batch_source: 'weekly', state: 'active' },
        { batch_id: 'A2', member_id: M, batch_source: 'weekly', state: 'active' },
      ],
    })
    expect((await enqueueBatch(c, { memberId: M, source: 'weekly', rows: rows('a') })).reason).toBe('inconsistent_batches')
    expect((await promoteIfResolved(c, M)).reason).toBe('inconsistent_batches')
    expect(c.__tables.intro_requests).toHaveLength(0)
  })

  it('no RPC result carries a member identifier', () => {
    for (const n of ['place_batch_rows', 'promote_queued_rows']) {
      const returns = Array.from(fn(n).matchAll(/RETURN jsonb_build_object\(([\s\S]*?)\);/g)).map((m) => m[1])
      expect(returns.length).toBeGreaterThan(0)
      for (const r of returns) {
        expect(r, `${n} return exposes an identifier`).not.toMatch(/member_id|requester_id|target_user_id|p_member_id/)
      }
    }
  })
})

// ── 7c. Repository-wide: no writer can bypass the RPCs ───────────────────────────────────────────

describe('7c. only the capacity RPCs can create or reveal a card', () => {
  // Every first-party source file, so the search cannot miss a writer by looking in the wrong place.
  const FILES = execSync(
    "find app lib -type f \\( -name '*.ts' -o -name '*.tsx' \\) -not -path '*/__tests__/*'",
    { encoding: 'utf8' },
  ).trim().split('\n')
  const SRC = FILES.map((f) => ({ f, t: readFileSync(f, 'utf8') }))

  it('no file writes a row into the VISIBLE or RESERVED tier outside the RPCs', () => {
    const offenders: string[] = []
    for (const { f, t } of SRC) {
      if (f === 'lib/introductions/migration-backfill.ts') continue   // covered by its own test below
      // an insert or update that sets status to a capacity-occupying value
      if (/status:\s*'(suggested|queued)'/.test(t)) offenders.push(f)
      // the dynamic form: status set from a variable in an intro_requests write
      if (/from\('intro_requests'\)[\s\S]{0,200}\.(insert|update)\([^)]*status:\s*(rowStatus|tier|v_tier)/.test(t)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })

  it('the only remaining direct inserts use statuses that occupy NEITHER tier', () => {
    const inserters = SRC.filter(({ t }) => /from\('intro_requests'\)\s*\n?\s*\.insert\(/.test(t)).map((x) => x.f).sort()
    // The exhaustive list. A new name appearing here is a new writer and must be justified.
    expect(inserters).toEqual([
      'app/api/intro-requests/accept-incoming/route.ts',   // accept incoming      → 'approved'
      'lib/introRequests/createAdminIntroPair.ts',         // admin concierge pair → 'admin_pending'
      'lib/introRequests/index.ts',                        // express interest     → 'pending'
      'lib/introductions/migration-backfill.ts',           // HARD-DISABLED; proven unreachable below
    ])
    for (const f of inserters) {
      if (f === 'lib/introductions/migration-backfill.ts') continue
      const t = readFileSync(f, 'utf8')
      let at = -1
      while ((at = t.indexOf("from('intro_requests')", at + 1)) > -1) {
        const block = t.slice(at, at + 600)
        if (!/\.insert\(/.test(block.slice(0, 60))) continue
        // an explicit, member-action status: never 'suggested', never 'queued', never implicit
        expect(block, `${f} inserts without an explicit non-tier status`)
          .toMatch(/status:\s*'(pending|approved|admin_pending|accepted|accepted_pending_payment)'/)
      }
    }
  })

  it('migration-backfill — the historic unlocked writer — cannot run', () => {
    const t = readFileSync('lib/introductions/migration-backfill.ts', 'utf8')
    const body = t.slice(t.indexOf('export async function applyBackfill'))
    // the throw precedes every database call, so no partial backfill can begin
    expect(body.indexOf('throw new Error')).toBeLessThan(body.indexOf('adminClient.from('))
    expect(body).toMatch(/disabled/)
  })

  it('reciprocal suggested rows come only from the hardened RPC', () => {
    // pair_id is what makes a row reciprocal. No application write may set it — reading it (the UI
    // reads pair_id to render the "Introduced by Andrel" label) is fine and common.
    const offenders = SRC.filter(({ t }) =>
      /\.(insert|update)\(\s*(\[\s*)?\{[^}]*pair_id\s*:/.test(t)).map((x) => x.f)
    expect(offenders).toEqual([])
    expect(SQL).toMatch(/INSERT INTO public\.intro_requests[\s\S]{0,300}pair_id/)
    expect(readFileSync('lib/matching/createReciprocalSuggestion.ts', 'utf8'))
      .toMatch(/rpc\('create_reciprocal_suggestion'/)
  })

  it('queued → suggested promotion exists in exactly one place, and it is the RPC', () => {
    const promoters = SRC.filter(({ f, t }) =>
      f !== 'lib/introductions/migration-backfill.ts' &&           // disabled; proven unreachable above
      /update\(\s*\{\s*status:\s*'suggested'/.test(t)).map((x) => x.f)
    expect(promoters).toEqual([])
    expect(SQL).toMatch(/UPDATE public\.intro_requests SET status = 'suggested'/)
  })

  it('UI slicing remains defence-in-depth, and is labelled as such', () => {
    const PAGE = readFileSync('app/dashboard/introductions/page.tsx', 'utf8')
    expect(PAGE).toMatch(/\.slice\(0, RECOMMENDATIONS_PER_BATCH\)/)
    expect(PAGE).toMatch(/belt-and-suspenders|defence|defense/i)
    // and it is NOT the enforcement point: the page never writes a card
    expect(PAGE).not.toMatch(/from\('intro_requests'\)[\s\S]{0,120}\.(insert|update|delete)\(/)
  })
})

// ── 8. What this suite does NOT prove ────────────────────────────────────────────────────────────

describe('8. the limits of this suite, stated rather than implied', () => {
  it('the in-memory model is a transcription, so concurrency is pinned in SQL text only', () => {
    // Vitest has no Postgres. Nothing here runs two transactions, so nothing here proves that two
    // concurrent producers serialize — only that the lock is present, hashes the member, and is
    // taken before counting (describe 3). Verifying the lock itself requires two real sessions:
    //   session 1: BEGIN; SELECT place_batch_rows(...);          -- do not commit
    //   session 2: BEGIN; SELECT place_batch_rows(<same member>); -- must block until 1 commits
    // That check belongs to the operator applying the migration, not to this file.
    const model = readFileSync('lib/__tests__/helpers/queueRpcModel.ts', 'utf8')
    expect(model).toMatch(/the advisory lock has no analogue here/)
  })

  it('the two-session harness covers every scenario only Postgres can prove', () => {
    // This suite drives a transcription. The harness drives TWO real sessions against a real
    // PostgreSQL, holding one transaction open and proving the other BLOCKS (55P03 under
    // lock_timeout), with a different-member control so it cannot pass by blocking on everything.
    const sh = readFileSync('scripts/verify-063-concurrency.sh', 'utf8')
    expect(sh).toMatch(/lock_timeout/)
    expect(sh).toMatch(/blocked:55P03/)
    expect(sh).toMatch(/a DIFFERENT member does NOT block \(control\)/)
    expect(sh).toMatch(/REFUSING/)                                  // refuses a non-disposable target
    expect(existsSync('supabase/tests/063_fixture.sql')).toBe(true)
    for (const scenario of [
      'reciprocal capacity is per-member and visible-only',
      'one call fills visible THEN reserved',
      'a full organic queue is NEVER deleted by admin placement',
      'concurrency (two real sessions)',
      'promotion: partial reveal, split, and batch completion',
      'p_max_cards cannot raise the database cap',
      'unsafe targets produce no unsafe write',
      'rollback leaves nothing',
      'FINAL INVARIANTS',
    ]) expect(sh, `missing scenario: ${scenario}`).toContain(scenario)
  })

  it('the eligibility gates the model does NOT simulate are present in the SQL', () => {
    // Stated rather than implied: the JS model covers capacity and batch mechanics only. These
    // gates need real tables, are exercised in the Postgres harness, and are pinned here so their
    // removal cannot pass unnoticed.
    const f = fn('place_batch_rows')
    expect(f).toMatch(/FROM public\.profiles p\s+WHERE p\.id = p_member_id/)     // member eligibility
    expect(f).toMatch(/WHERE p\.id = d\.target_user_id/)                          // target eligibility
    expect(f).toMatch(/FROM public\.blocked_users bu/)                            // blocks, both ways
    expect(f).toMatch(/FROM public\.matches m/)                                   // already connected
    expect(f).toMatch(/ir\.status IN \('passed','expired'\) AND ir\.updated_at >= v_cutoff/) // cooldown
    expect(readFileSync('lib/__tests__/helpers/queueRpcModel.ts', 'utf8'))
      .toMatch(/ELIGIBILITY IS NOT MODELLED/)
  })

  it('063 is registered nowhere in migration-health, deliberately and documented', () => {
    // The function-probe machinery in lib/db/migrationHealth.ts belongs to unrelated company-admin
    // work that is NOT part of this change, so a 063 entry could not be staged independently of it.
    // The gap is real and must not be glossed: with 063 unapplied the dashboard stays GREEN.
    expect(readFileSync('lib/db/migrationHealth.ts', 'utf8')).not.toContain('063_unified')
    // What actually protects ordering: placement THROWS, so the failure is "no recommendations",
    // never "over-capacity recommendations".
    expect(QUEUE).toMatch(/place_batch_rows failed/)
    const doc = readFileSync('docs/MIGRATION_063_HEALTH_VISIBILITY.md', 'utf8')
    expect(doc).toMatch(/NOT visible in the migration-health dashboard/)
    expect(doc).toMatch(/probeArgs: \{ p_member_id: null, p_source: 'weekly', p_rows: \[\] \}/)
  })

  it('the migration is not applied by this repo and modifies no data', () => {
    expect(SQL).toMatch(/NOT YET APPLIED/)
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION/)
    // No DML OUTSIDE the function bodies: applying this file defines functions and changes no rows.
    // Existing over-capacity members are a separate, reviewed cleanup. (DML inside a body only runs
    // when the function is called.)
    const outsideBodies = SQL.split(/\$\$/).filter((_, i) => i % 2 === 0).join('\n')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')   // prose is not a statement
    expect(outsideBodies).not.toMatch(/\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO|ALTER\s+TABLE|DROP)\b/i)
  })
})
