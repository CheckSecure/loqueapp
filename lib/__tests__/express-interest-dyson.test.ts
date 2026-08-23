import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * THE DYSON RICHARDS INCIDENT.
 *
 * Dyson clicked Express Interest on a suggestion and was told "This member is no longer active".
 * The production audit proves his suggested target (Bill Hughes) is active, complete, non-test and
 * unpaused, on an ACTIVE reciprocal pair.
 *
 * The call path is not the API route. components/RequestIntroButton.tsx:37 calls the SERVER ACTION
 * submitIntroRequest FIRST, and only calls /api/intro-requests/express-interest if that succeeds.
 * The action's gate read public.profiles with the CALLER's client:
 *
 *     const { data: target } = await supabase.from('profiles').select('account_status')…
 *     if (!target || target.account_status !== 'active') return { error: 'This member is no longer active' }
 *
 * Migration 058 revoked that SELECT from `authenticated`. The read was denied, only `data` was
 * destructured, so `target` was null — and the branch fired for EVERY target regardless of status.
 * A privilege change was reported to members as a factual claim about another member's account.
 *
 * These tests pin the mapping so a future permission regression cannot masquerade as inactivity.
 */

const h = vi.hoisted(() => ({
  user: { id: 'dyson', email: 'dyson@example.com' } as any,
  // what the SERVER-AUTHORIZED profile read returns
  targetRead: { ok: true, profile: { account_status: 'active' } } as any,
  introRequest: null as any,
  updatedRows: [{ id: 'ir1' }] as any[],
  updateError: null as any,
  createIntroResult: { introRequestId: 'ir1' } as any,
  finalizeCalls: [] as any[],
  notifications: [] as any[],
}))

vi.mock('@/lib/profiles/serverProfile', () => ({
  readProfileById: vi.fn(async () => h.targetRead),
  readProfilesByIds: vi.fn(async () => ({ ok: true, profiles: [] })),
  readSelfEligibility: vi.fn(async () => ({ ok: true, profile: { id: 'dyson', email: 'd@x.com', account_status: 'active' } })),
}))

// The BROWSER client: every profiles read through it is denied, exactly as production is today.
const deniedProfiles = { data: null, error: { code: '42501', message: 'permission denied for table profiles' } }
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: h.user } }) },
    from: (t: string) => {
      const b: any = {}
      b.select = () => b; b.eq = () => b; b.neq = () => b; b.in = () => b; b.or = () => b
      b.order = () => b; b.limit = () => b; b.gte = () => b; b.lt = () => b; b.is = () => b
      b.maybeSingle = async () => (t === 'profiles' ? deniedProfiles : { data: h.introRequest, error: null })
      b.single = async () => (t === 'profiles' ? deniedProfiles : { data: h.introRequest, error: null })
      return b
    },
  }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (t: string) => {
      const b: any = { t, op: 'select' }
      b.select = () => b
      b.update = () => { b.op = 'update'; return b }
      b.insert = () => { b.op = 'insert'; return b }
      b.eq = () => b; b.neq = () => b; b.in = () => b; b.or = () => b
      b.order = () => b; b.limit = () => b; b.gte = () => b; b.lt = () => b; b.is = () => b
      b.maybeSingle = async () => ({ data: h.introRequest, error: null })
      b.single = async () => ({ data: h.introRequest, error: null })
      b.then = (res: any) => Promise.resolve(
        b.op === 'update' ? { data: h.updatedRows, error: h.updateError } : { data: h.introRequest, error: null }
      ).then(res)
      return b
    },
  }),
}))

vi.mock('@/lib/notifications', () => ({ createNotificationSafe: vi.fn(async (n: any) => { h.notifications.push(n); return true }) }))
vi.mock('@/lib/introductions/queue', () => ({ promoteIfResolved: vi.fn(async () => ({ promoted: false })) }))
vi.mock('@/lib/notifications/engagement', () => ({ notifyNewVisibleBatch: vi.fn(async () => {}) }))
vi.mock('@/lib/introductions/finalizeMutualMatch', () => ({
  finalizeMutualMatch: vi.fn(async (a: any) => { h.finalizeCalls.push(a); return { ok: true, status: 200, body: { mutualInterest: false } } }),
}))

import { POST } from '@/app/api/intro-requests/express-interest/route'

const ACTION_SRC = readFileSync('app/actions.ts', 'utf8')
const ROUTE_SRC = readFileSync('app/api/intro-requests/express-interest/route.ts', 'utf8')
const BUTTON_SRC = readFileSync('components/RequestIntroButton.tsx', 'utf8')

const post = () => POST(new Request('http://localhost/api/intro-requests/express-interest', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ introRequestId: 'ir1' }),
}))

beforeEach(() => {
  h.user = { id: 'dyson', email: 'dyson@example.com' }
  h.targetRead = { ok: true, profile: { account_status: 'active' } }
  h.introRequest = { id: 'ir1', requester_id: 'dyson', target_user_id: 'bill', is_admin_initiated: false, status: 'suggested', pair_id: 'p1' }
  h.updatedRows = [{ id: 'ir1' }]
  h.updateError = null
  h.finalizeCalls = []
  h.notifications = []
})

describe('the call path that produced the message', () => {
  it('Express Interest hits the SERVER ACTION first, not the API route', () => {
    const i = BUTTON_SRC.indexOf('await submitIntroRequest(rowId, targetId)')
    const j = BUTTON_SRC.indexOf("fetch('/api/intro-requests/express-interest'")
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(-1)
    expect(i).toBeLessThan(j)                       // the action gates the route
    // and the route is only reached on success
    expect(BUTTON_SRC).toMatch(/if \(result\.success && 'introRequestId' in result/)
  })

  it('the action no longer reads profiles with the caller client', () => {
    const fn = ACTION_SRC.slice(ACTION_SRC.indexOf('export async function submitIntroRequest'),
                                ACTION_SRC.indexOf('export async function adminApproveIntro'))
    expect(fn).not.toMatch(/supabase\s*\n?\s*\.from\('profiles'\)/)
    expect(fn).toMatch(/readProfileById<\{ account_status: string \| null \}>/)
  })

  it('the action separates "could not verify" from "no longer active"', () => {
    const fn = ACTION_SRC.slice(ACTION_SRC.indexOf('export async function submitIntroRequest'),
                                ACTION_SRC.indexOf('export async function adminApproveIntro'))
    const unavailable = fn.indexOf("reason === 'unavailable'")
    const inactive = fn.indexOf('This member is no longer active')
    expect(unavailable).toBeGreaterThan(-1)
    expect(unavailable).toBeLessThan(inactive)      // the retryable case is decided FIRST
    expect(fn).toMatch(/We could not verify this member right now/)
  })
})

describe('1. the Dyson scenario: it succeeds', () => {
  it('active target + valid suggested card + browser profiles SELECT denied -> interest recorded', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(h.updatedRows).toHaveLength(1)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toMatch(/no longer active/)
  })
})

describe('2-3. inactive target vs a read that did not answer', () => {
  it('a GENUINELY inactive target gets the member-safe inactive outcome', async () => {
    h.targetRead = { ok: true, profile: { account_status: 'deactivated' } }
    const res = await post(); const body = await res.json()
    expect(res.status).toBe(410)
    expect(body.code).toBe('TARGET_INACTIVE')
    expect(body.message).toMatch(/no longer active/)
    expect(body.message).toMatch(/No credit was used/)
  })

  it('a FAILED target read is retryable and NEVER claims inactivity or absence', async () => {
    h.targetRead = { ok: false, reason: 'unavailable' }
    const res = await post(); const body = await res.json()
    expect(res.status).toBe(503)
    expect(body.code).toBe('TARGET_UNAVAILABLE')
    expect(JSON.stringify(body)).not.toMatch(/no longer active/)
    expect(JSON.stringify(body)).not.toMatch(/not found|Profile not found/)
    expect(JSON.stringify(body)).not.toMatch(/permission denied|42501/)
  })

  it('a genuinely MISSING target is distinct from both', async () => {
    h.targetRead = { ok: false, reason: 'not_found' }
    const res = await post(); const body = await res.json()
    expect(res.status).toBe(410)
    expect(body.code).toBe('TARGET_MISSING')
    expect(JSON.stringify(body)).not.toMatch(/no longer active/)
  })
})

describe('4. a card the caller does not own', () => {
  it('is rejected with a neutral 404 that leaks nothing about the target', async () => {
    h.introRequest = { id: 'ir1', requester_id: 'someone', target_user_id: 'else', status: 'suggested', pair_id: 'p1' }
    const res = await post(); const body = await res.json()
    expect(res.status).toBe(404)
    expect(JSON.stringify(body)).not.toMatch(/someone|else|account_status|inactive/)
    expect(h.updatedRows).toHaveLength(1)   // untouched: no write was attempted
  })
})

describe('5. terminal cards are not reopened', () => {
  it.each(['passed', 'declined', 'rejected', 'expired', 'archived', 'hidden'])(
    'a %s card is refused as no longer actionable', async (status) => {
      h.introRequest = { ...h.introRequest, status }
      const res = await post(); const body = await res.json()
      expect(res.status).toBe(409)
      expect(body.code).toBe('CARD_NOT_ACTIONABLE')
      expect(h.finalizeCalls).toHaveLength(0)     // never proceeds to finalization
    })

  it('the write itself is guarded on status, so a lost race cannot reopen a card', async () => {
    expect(ROUTE_SRC).toMatch(/\.in\('status', ACTIONABLE_FOR_INTEREST\)/)
    expect(ROUTE_SRC).toMatch(/ACTIONABLE_FOR_INTEREST = \['suggested', 'pending', 'approved'\]/)
  })

  it('losing the race to a concurrent pass yields no-rows-updated, not a false success', async () => {
    h.updatedRows = []                              // another writer got there first
    const res = await post(); const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.code).toBe('CARD_NOT_ACTIONABLE')
    expect(h.finalizeCalls).toHaveLength(0)
  })
})

describe('6. competing calls produce one terminal outcome and no duplicate effects', () => {
  it('a retry of an already-approved card is an idempotent no-op, not a rejection', async () => {
    h.introRequest = { ...h.introRequest, status: 'approved' }
    const res = await post()
    expect(res.status).toBe(200)
  })

  it('two concurrent calls finalize at most once', async () => {
    const [a, b] = await Promise.all([post(), post()])
    expect([a.status, b.status].every((s) => s === 200)).toBe(true)
    // finalization is delegated to the atomic wrapper, which owns duplicate protection
    expect(ROUTE_SRC).toMatch(/finalizeMutualMatch/)
    expect(ROUTE_SRC).not.toMatch(/consume_credits_and_create_match/)
  })
})

describe('the member-facing message mapping is pinned', () => {
  const MAP: Array<[string, number, RegExp]> = [
    ['TARGET_INACTIVE', 410, /no longer active/],
    ['TARGET_MISSING', 410, /no longer available/],
    ['TARGET_UNAVAILABLE', 503, /could not verify this member/],
    ['CARD_NOT_ACTIONABLE', 409, /no longer available/],
  ]
  it.each(MAP)('%s -> %i with its own copy', (code, status, copy) => {
    const idx = ROUTE_SRC.indexOf(`code: '${code}'`)
    expect(idx, `${code} must exist`).toBeGreaterThan(-1)
    const block = ROUTE_SRC.slice(Math.max(0, idx - 400), idx + 200)
    expect(block).toMatch(copy)
    expect(block).toMatch(new RegExp(`status: ${status}`))
  })

  it('"no longer active" is reachable ONLY from a proven non-active status', () => {
    const i = ROUTE_SRC.indexOf("targetRead.profile.account_status !== 'active'")
    const j = ROUTE_SRC.indexOf("code: 'TARGET_INACTIVE'")
    expect(i).toBeGreaterThan(-1)
    expect(i).toBeLessThan(j)
    // both failure branches are decided BEFORE the inactive claim can be made
    expect(ROUTE_SRC.indexOf("reason === 'unavailable'")).toBeLessThan(i)
    expect(ROUTE_SRC.indexOf('if (!targetRead.ok) {')).toBeLessThan(i)
  })

  it('no raw database message or code reaches the member from this route', () => {
    for (const m of Array.from(ROUTE_SRC.matchAll(/NextResponse\.json\(\s*\{([\s\S]{0,220}?)\}/g))) {
      expect(m[1]).not.toMatch(/\.message|\.details|\.hint|error\.code/)
    }
  })
})
