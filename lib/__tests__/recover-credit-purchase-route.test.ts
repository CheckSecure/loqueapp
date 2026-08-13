import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const requireAdmin = vi.fn()
const fulfill = vi.fn()
const eventsRetrieve = vi.fn()
const sessionsRetrieve = vi.fn()

vi.mock('@/lib/admin/requireAdmin', () => ({ requireAdmin: () => requireAdmin() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/stripe', () => ({
  stripe: {
    events: { retrieve: (...a: any[]) => eventsRetrieve(...a) },
    checkout: { sessions: { retrieve: (...a: any[]) => sessionsRetrieve(...a) } },
  },
}))
vi.mock('@/lib/stripe/fulfillCreditPurchase', () => ({
  fulfillCreditPurchase: (...a: any[]) => fulfill(...a),
  realFulfillDeps: () => ({}),
}))

import { POST, GET } from '@/app/api/admin/stripe/recover-credit-purchase/route'

const EVENT = 'evt_1U3KCTDuNRcLQVf1DAyHzfbi'
const SESS = 'cs_live_a1LuIGjHMXbA5pewAtakXStqdfOEiXvtyLiN2w2m7EJ3RStRkybhJhbhLB'

const req = (body: any, opts: { throwOnJson?: boolean; headers?: Record<string, string> } = {}) => ({
  json: async () => { if (opts.throwOnJson) throw new Error('bad'); return body },
  headers: new Headers({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(opts.headers ?? {}) }),
}) as any
const allow = () => requireAdmin.mockResolvedValue({ user: { email: 'admin' }, error: null })
const deny = () => requireAdmin.mockResolvedValue({ user: null, error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })

beforeEach(() => {
  requireAdmin.mockReset(); fulfill.mockReset(); eventsRetrieve.mockReset(); sessionsRetrieve.mockReset()
  fulfill.mockResolvedValue({ outcome: 'granted', retryable: false })
  eventsRetrieve.mockResolvedValue({ id: EVENT, type: 'checkout.session.completed', data: { object: { id: SESS } } })
  sessionsRetrieve.mockResolvedValue({ id: SESS })
})

describe('authorization + CSRF precede any Stripe/service-role work', () => {
  it('non-admin → 403, nothing fetched or fulfilled', async () => {
    deny()
    const res = await POST(req({ eventId: EVENT }))
    expect(res.status).toBe(403)
    expect(eventsRetrieve).not.toHaveBeenCalled(); expect(fulfill).not.toHaveBeenCalled()
  })
  it('cross-site → 403', async () => {
    allow()
    const res = await POST(req({ eventId: EVENT }, { headers: { 'sec-fetch-site': 'cross-site' } }))
    expect(res.status).toBe(403); expect(fulfill).not.toHaveBeenCalled()
  })
})

describe('strict single-identifier validation (no user id / credits / bulk)', () => {
  beforeEach(() => allow())
  const rejects = async (body: any, opts: any = {}) => {
    const res = await POST(req(body, opts)); expect(res.status).toBe(400); expect(fulfill).not.toHaveBeenCalled()
  }
  it('rejects non-JSON', () => rejects({ eventId: EVENT }, { headers: { 'content-type': 'text/plain' } }))
  it('rejects malformed JSON', () => rejects(undefined, { throwOnJson: true }))
  it('rejects empty body', () => rejects({}))
  it('rejects BOTH eventId and sessionId', () => rejects({ eventId: EVENT, sessionId: SESS }))
  it('rejects an extra key', () => rejects({ eventId: EVENT, foo: 1 }))
  it('rejects an arbitrary userId', () => rejects({ userId: 'u' }))
  it('rejects a credits amount', () => rejects({ credits: 25 }))
  it('rejects sessionId + credits (no quantity override)', () => rejects({ sessionId: SESS, credits: 25 }))
  it('rejects an array body', () => rejects([EVENT]))
  it('rejects a malformed event id', () => rejects({ eventId: 'not-an-event' }))
  it('rejects a malformed session id', () => rejects({ sessionId: 'nope' }))
  it('rejects a non-string identifier', () => rejects({ eventId: 123 }))
})

describe('authorized recovery delegates to the canonical fulfillment', () => {
  beforeEach(() => allow())
  it('eventId → fetches the event, fulfills with {eventId, session}, returns coarse outcome + no-store', async () => {
    const res = await POST(req({ eventId: EVENT }))
    expect(eventsRetrieve).toHaveBeenCalledWith(EVENT)
    expect(fulfill.mock.calls[0][1]).toEqual({ eventId: EVENT, session: { id: SESS } })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['ok', 'outcome'])
    expect(body).toEqual({ ok: true, outcome: 'granted' })
  })
  it('a non-checkout event id → invalid (200), no fulfillment', async () => {
    eventsRetrieve.mockResolvedValue({ id: EVENT, type: 'customer.subscription.updated', data: { object: {} } })
    const res = await POST(req({ eventId: EVENT }))
    expect(res.status).toBe(200); expect((await res.json()).outcome).toBe('invalid')
    expect(fulfill).not.toHaveBeenCalled()
  })
  it('sessionId → retrieves the session, fulfills with a synthetic recovery event id', async () => {
    const res = await POST(req({ sessionId: SESS }))
    expect(sessionsRetrieve).toHaveBeenCalledWith(SESS)
    expect(fulfill.mock.calls[0][1]).toEqual({ eventId: `recovery:${SESS}`, session: { id: SESS } })
    expect(res.status).toBe(200)
  })
  it('maps coarse outcomes to status (already_processed 200, conflict 409, payment_not_settled 409, error 500)', async () => {
    for (const [outcome, status, retryable] of [
      ['already_processed', 200, false], ['conflict', 409, false], ['payment_not_settled', 409, false], ['error', 500, true],
    ] as const) {
      fulfill.mockResolvedValueOnce({ outcome, retryable })
      const res = await POST(req({ eventId: EVENT }))
      expect(res.status, outcome).toBe(status)
    }
  })
  it('response never exposes identifiers or secrets', async () => {
    const res = await POST(req({ eventId: EVENT }))
    const raw = JSON.stringify(await res.json())
    expect(raw).not.toContain(SESS); expect(raw).not.toContain('cus_'); expect(raw).not.toContain('@')
  })
  it('GET → 405', async () => { expect((await GET()).status).toBe(405) })
})

describe('route source guarantees', () => {
  const src = require('node:fs').readFileSync('app/api/admin/stripe/recover-credit-purchase/route.ts', 'utf8')
  it('authorizes before Stripe, accepts no user id/credits, delegates to the shared fulfillment', () => {
    expect(src.indexOf('assertSameOrigin(req)')).toBeLessThan(src.indexOf('requireAdmin()'))
    expect(src.indexOf('requireAdmin()')).toBeLessThan(src.indexOf('req.json()'))
    expect(src).toContain('fulfillCreditPurchase')
    expect(src).not.toMatch(/p_credits|creditsPurchased|body\.userId|body\.credits/)
  })
})
