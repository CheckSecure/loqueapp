import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fulfillCreditPurchase, type FulfillDeps, type SessionLike } from '@/lib/stripe/fulfillCreditPurchase'
import { CREDIT_CAPACITY, CREDIT_CHECKOUT_TTL_SECONDS, isUuid } from '@/lib/stripe/creditReservations'

const reservationId = '6f5a3028-ce18-4a25-96f9-d761066dfa19'
const userId = '1230d5b2-2f28-442a-bae0-1ba4f32cd7c4'
const session: SessionLike = {
  id: 'cs_2b', mode: 'payment', status: 'complete', payment_status: 'paid', currency: 'usd',
  amount_total: 2500, customer: 'cus_2b', expires_at: 1_800_000_000,
  metadata: { supabase_user_id: userId, credit_reservation_id: reservationId },
}

function deps(overrides: Partial<FulfillDeps> = {}) {
  const calls: string[] = []
  const base: FulfillDeps = {
    retrieveSession: async () => session,
    listLineItems: async () => [{ priceId: 'price_5', quantity: 1 }],
    loadProfileById: async () => ({ id: userId, stripe_customer_id: 'cus_2b' }),
    bindReservation: async () => { calls.push('bind'); return 'bound' },
    grantReserved: async () => { calls.push('grant_reserved'); return 'granted' },
    grantLegacy: async () => { calls.push('grant_legacy'); return 'granted' },
    creditPacks: [{ priceId: 'price_5', credits: 5, amount: 25 }],
    log: () => {},
  }
  return { calls, value: { ...base, ...overrides } as FulfillDeps }
}

describe('Release 2B — reservation-backed credit checkout', () => {
  it('uses the agreed 50-credit capacity and a Stripe-valid 30-minute lease', () => {
    expect(CREDIT_CAPACITY).toBe(50)
    expect(CREDIT_CHECKOUT_TTL_SECONDS).toBe(1800)
  })

  it('accepts only real UUID reservation ids', () => {
    expect(isUuid(reservationId)).toBe(true)
    expect(isUuid('not-a-reservation')).toBe(false)
  })

  it('binds before atomically granting a new reserved purchase', async () => {
    const h = deps()
    expect(await fulfillCreditPurchase(h.value, { eventId: 'evt_2b', session })).toEqual({ outcome: 'granted', retryable: false })
    expect(h.calls).toEqual(['bind', 'grant_reserved'])
  })

  it('never grants when reservation binding conflicts', async () => {
    const h = deps({ bindReservation: async () => { h.calls.push('bind'); return 'conflict' } })
    expect((await fulfillCreditPurchase(h.value, { eventId: 'evt_2b', session })).outcome).toBe('conflict')
    expect(h.calls).toEqual(['bind'])
  })

  it('keeps the legacy grant path only for already-open sessions without reservation metadata', async () => {
    const h = deps()
    const legacy = { ...session, metadata: { supabase_user_id: userId } }
    expect((await fulfillCreditPurchase(h.value, { eventId: 'evt_old', session: legacy })).outcome).toBe('granted')
    expect(h.calls).toEqual(['grant_legacy'])
  })

  it('checkout rejects unknown payment prices before Stripe and reserves before session creation', () => {
    const src = readFileSync('app/api/stripe/checkout/route.ts', 'utf8')
    expect(src.indexOf("mode === 'payment' && !creditPack")).toBeLessThan(src.indexOf('stripe.checkout.sessions.create'))
    expect(src.indexOf('reserveCreditPurchase(admin')).toBeLessThan(src.indexOf('stripe.checkout.sessions.create'))
    expect(src).toContain('metadata.credit_reservation_id = reservationId')
    expect(src).toContain('client_reference_id: reservationId')
    expect(src).toContain('expires_at: Math.floor')
    expect(src).toContain('stripe.checkout.sessions.expire(session.id)')
    const expire = src.indexOf('stripe.checkout.sessions.expire(session.id)')
    expect(expire).toBeLessThan(src.indexOf('await releaseUnboundReservation()', expire))
  })

  it('expiration webhook binds the crash-window reservation before releasing it', () => {
    const src = readFileSync('app/api/stripe/webhook/route.ts', 'utf8')
    const expired = src.indexOf("event.type === 'checkout.session.expired'")
    const bind = src.indexOf('bindCreditReservation(adminClient', expired)
    const release = src.indexOf('releaseCreditReservation(adminClient', expired)
    expect(expired).toBeGreaterThan(-1)
    expect(bind).toBeGreaterThan(expired)
    expect(release).toBeGreaterThan(bind)
    expect(src.slice(expired, release)).toContain("bind === 'conflict'")
  })

  it('billing copy states the combined cap without the retired 60-credit promise', () => {
    const billing = readFileSync('app/dashboard/billing/page.tsx', 'utf8')
    expect(billing).toContain('combined balance up to 50 credits')
    expect(billing).not.toMatch(/up to 60/i)
  })

  it('removes the obsolete warning endpoint and component so checkout is the sole cap authority', () => {
    const exists = require('node:fs').existsSync
    expect(exists('app/api/billing/check-credit-purchase/route.ts')).toBe(false)
    expect(exists('components/CreditPurchaseWarning.tsx')).toBe(false)
  })
})
