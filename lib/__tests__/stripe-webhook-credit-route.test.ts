import { describe, it, expect, vi, beforeEach } from 'vitest'

const constructEvent = vi.fn()
const fulfill = vi.fn()
const bindReservation = vi.fn()
const releaseReservation = vi.fn()
const eventsInserted: any[] = []

vi.mock('@/lib/stripe', () => ({
  stripe: { webhooks: { constructEvent: (...a: any[]) => constructEvent(...a) } },
}))
vi.mock('@/lib/stripe/fulfillCreditPurchase', () => ({
  fulfillCreditPurchase: (...a: any[]) => fulfill(...a),
  realFulfillDeps: () => ({}),
}))
vi.mock('@/lib/stripe/creditReservations', () => ({
  isUuid: (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v),
  bindCreditReservation: (...a: any[]) => bindReservation(...a),
  releaseCreditReservation: (...a: any[]) => releaseReservation(...a),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (t: string) => ({
      insert: async (row: any) => { eventsInserted.push({ t, row }); return { error: null } },
      update: () => ({ eq: async () => ({ error: null }) }),
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
  }),
}))

import { POST } from '@/app/api/stripe/webhook/route'
import { POST as apexPOST } from '@/app/api/webhooks/stripe/route'

const req = (headers: Record<string, string> = {}) => ({
  text: async () => '{}',
  headers: new Headers({ 'stripe-signature': 'sig', ...headers }),
}) as any

beforeEach(() => {
  constructEvent.mockReset(); fulfill.mockReset(); eventsInserted.length = 0
  bindReservation.mockReset().mockResolvedValue('bound')
  releaseReservation.mockReset().mockResolvedValue('released')
})

describe('canonical webhook — credit fulfillment path', () => {
  it('routes checkout.session.completed to fulfillCreditPurchase (NOT the stripe_events marker)', async () => {
    constructEvent.mockReturnValue({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } })
    fulfill.mockResolvedValue({ outcome: 'granted', retryable: false })
    const res = await POST(req())
    expect(fulfill).toHaveBeenCalledTimes(1)
    expect(fulfill.mock.calls[0][1]).toEqual({ eventId: 'evt_1', session: { id: 'cs_1' } })
    expect(res.status).toBe(200)
    // credit path does NOT pre-claim stripe_events (grant idempotency lives in credit_grants).
    expect(eventsInserted.find((e) => e.t === 'stripe_events')).toBeUndefined()
  })

  it('a RETRYABLE fulfillment outcome → 500 so Stripe retries, and NO stripe_events row is written (not poisoned)', async () => {
    constructEvent.mockReturnValue({ id: 'evt_2', type: 'checkout.session.completed', data: { object: { id: 'cs_2' } } })
    fulfill.mockResolvedValue({ outcome: 'error', retryable: true })
    const res = await POST(req())
    expect(res.status).toBe(500)
    expect(eventsInserted.find((e) => e.t === 'stripe_events')).toBeUndefined() // credit path never pre-claims
  })

  it('an ownership CONFLICT is terminal (200) but writes NO stripe_events and NO grant marker (not marked fulfilled)', async () => {
    constructEvent.mockReturnValue({ id: 'evt_3', type: 'checkout.session.completed', data: { object: { id: 'cs_3' } } })
    fulfill.mockResolvedValue({ outcome: 'conflict', retryable: false }) // fulfill returns BEFORE any grant
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(eventsInserted.find((e) => e.t === 'stripe_events')).toBeUndefined()
  })

  it('a terminal outcome (conflict/invalid/already_processed) → 200 (no retry storm)', async () => {
    for (const outcome of ['conflict', 'invalid', 'already_processed', 'payment_not_settled'] as const) {
      constructEvent.mockReturnValue({ id: 'evt_x', type: 'checkout.session.completed', data: { object: { id: 'cs_x' } } })
      fulfill.mockResolvedValue({ outcome, retryable: false })
      const res = await POST(req())
      expect(res.status, outcome).toBe(200)
    }
  })

  it('an expired credit checkout binds the crash-window reservation before releasing capacity', async () => {
    constructEvent.mockReturnValue({
      id: 'evt_expired', type: 'checkout.session.expired', data: { object: {
        id: 'cs_expired', expires_at: 1_800_000_000,
        metadata: {
          supabase_user_id: '1230d5b2-2f28-442a-bae0-1ba4f32cd7c4',
          credit_reservation_id: '6f5a3028-ce18-4a25-96f9-d761066dfa19',
        },
      } },
    })
    const response = await POST(req())
    expect(response.status).toBe(200)
    expect(bindReservation).toHaveBeenCalledTimes(1)
    expect(releaseReservation).toHaveBeenCalledTimes(1)
    expect(bindReservation.mock.invocationCallOrder[0]).toBeLessThan(releaseReservation.mock.invocationCallOrder[0])
    expect(releaseReservation.mock.calls[0][1]).toMatchObject({ sessionId: 'cs_expired', reason: 'stripe_expired' })
    expect(eventsInserted).toEqual([])
  })

  it('a transient expiration-release failure returns 500 so Stripe retries', async () => {
    constructEvent.mockReturnValue({
      id: 'evt_expired', type: 'checkout.session.expired', data: { object: {
        id: 'cs_expired', metadata: {
          supabase_user_id: '1230d5b2-2f28-442a-bae0-1ba4f32cd7c4',
          credit_reservation_id: '6f5a3028-ce18-4a25-96f9-d761066dfa19',
        },
      } },
    })
    releaseReservation.mockRejectedValue(new Error('db unavailable'))
    expect((await POST(req())).status).toBe(500)
  })

  it('an invalid signature → 400, no fulfillment', async () => {
    constructEvent.mockImplementation(() => { throw new Error('bad sig') })
    const res = await POST(req())
    expect(res.status).toBe(400); expect(fulfill).not.toHaveBeenCalled()
  })

  it('subscription events still use the INSERT-first stripe_events idempotency (not the credit path)', async () => {
    constructEvent.mockReturnValue({ id: 'evt_sub', type: 'customer.subscription.updated', data: { object: { customer: 'cus_1', status: 'active', id: 'sub_1', items: { data: [{ price: { id: 'price_x' }, current_period_end: 0 }] } } } })
    const res = await POST(req())
    expect(fulfill).not.toHaveBeenCalled()
    expect(eventsInserted.find((e) => e.t === 'stripe_events')?.row).toEqual({ event_id: 'evt_sub' })
    expect(res.status).toBe(200)
  })

  it('subscription.created/updated/deleted NEVER touch meeting_credits (anniversary refill is authoritative)', async () => {
    for (const type of ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']) {
      eventsInserted.length = 0
      constructEvent.mockReturnValue({ id: `evt_${type}`, type, data: { object: { customer: 'cus_1', status: 'active', id: 'sub_1', items: { data: [{ price: { id: 'price_x' }, current_period_end: 0 }] } } } })
      const res = await POST(req())
      expect(res.status).toBe(200)
      expect(eventsInserted.find((e) => e.t === 'meeting_credits'), type).toBeUndefined() // no included-credit mutation
    }
  })

  it('the webhook source contains no meeting_credits write on any subscription path', () => {
    const src = require('node:fs').readFileSync('app/api/stripe/webhook/route.ts', 'utf8')
    // The only meeting_credits interaction in the whole file is via the fulfillment module (purchases).
    expect(src).not.toMatch(/from\('meeting_credits'\)/)
    expect(src).not.toMatch(/getMonthlyCredits/) // no included-credit floor logic remains here
  })
})

describe('retired apex route delegates to the canonical handler (no independent grant, shared idempotency)', () => {
  it('exports the SAME POST function as the canonical route', () => {
    expect(apexPOST).toBe(POST)
  })
  it('the apex route contains no independent credit-granting logic', () => {
    const src = require('node:fs').readFileSync('app/api/webhooks/stripe/route.ts', 'utf8')
    expect(src).not.toMatch(/meeting_credits|premium_credits|getCreditCap|creditsPurchased/)
    expect(src).toContain("export { POST } from '@/app/api/stripe/webhook/route'")
  })
})

describe('canonical route verifies against its OWN endpoint secret (no "either secret")', () => {
  it('resolves exactly one secret, preferring the clearly-named canonical variable', () => {
    const src = require('node:fs').readFileSync('app/api/stripe/webhook/route.ts', 'utf8')
    expect(src).toContain('process.env.STRIPE_WEBHOOK_SECRET_CANONICAL || process.env.STRIPE_WEBHOOK_SECRET')
    // Verification uses the single resolved secret — never tries multiple secrets.
    expect(src).toContain('stripe.webhooks.constructEvent(body, sig, webhookSecret)')
  })
})
