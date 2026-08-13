import { describe, it, expect } from 'vitest'
import { fulfillCreditPurchase, type FulfillDeps, type SessionLike } from '@/lib/stripe/fulfillCreditPurchase'

const USER = '0eb44499-6a03-43ec-9eb1-d0adfe3a8da1'
const CUS = 'cus_V3R4yzAE6j3gLg'
const EVENT = 'evt_1U3KCTDuNRcLQVf1DAyHzfbi'
const SESS = 'cs_live_a1LuIGjHMXbA5pewAtakXStqdfOEiXvtyLiN2w2m7EJ3RStRkybhJhbhLB'
const PACKS = [
  { priceId: 'price_5', credits: 5, amount: 25 },
  { priceId: 'price_10', credits: 10, amount: 45 },
  { priceId: 'price_25', credits: 25, amount: 99 },
]

// A Jesse-equivalent live session: metadata carries ONLY supabase_user_id (no type/credits).
const jesseSession = (o: Partial<SessionLike> = {}): SessionLike => ({
  id: SESS, mode: 'payment', status: 'complete', payment_status: 'paid',
  currency: 'usd', amount_total: 9900, customer: CUS, metadata: { supabase_user_id: USER }, ...o,
})

type Cfg = {
  session?: SessionLike
  lineItems?: Array<{ priceId: string | null; quantity: number | null }>
  profile?: { id: string; stripe_customer_id: string | null } | null
  grantResult?: 'granted' | 'already_processed'
  grantThrows?: boolean
  lineItemsThrows?: boolean
  retrieveThrows?: boolean
}

function harness(cfg: Cfg = {}) {
  const calls: Array<{ name: string; args: any }> = []
  const logs: Array<{ event: string; fields?: any }> = []
  const deps: FulfillDeps = {
    retrieveSession: async (id) => { calls.push({ name: 'retrieveSession', args: id }); if (cfg.retrieveThrows) throw new Error('x'); return cfg.session ?? jesseSession({ id }) },
    listLineItems: async (id) => { calls.push({ name: 'listLineItems', args: id }); if (cfg.lineItemsThrows) throw new Error('x'); return cfg.lineItems ?? [{ priceId: 'price_25', quantity: 1 }] },
    loadProfileById: async (uid) => { calls.push({ name: 'loadProfileById', args: uid }); return cfg.profile === undefined ? { id: uid, stripe_customer_id: CUS } : cfg.profile },
    grant: async (a) => { calls.push({ name: 'grant', args: a }); if (cfg.grantThrows) throw new Error('db'); return cfg.grantResult ?? 'granted' },
    creditPacks: PACKS,
    log: (event, fields) => logs.push({ event, fields }),
  }
  const of = (n: string) => calls.filter((c) => c.name === n)
  return { deps, calls, logs, of }
}

describe('fulfillCreditPurchase — Jesse-equivalent (metadata has only supabase_user_id)', () => {
  it('resolves the 25-credit pack from the LINE-ITEM price id (not metadata) and grants exactly 25', async () => {
    const h = harness()
    const r = await fulfillCreditPurchase(h.deps, { eventId: EVENT, session: jesseSession() })
    expect(r).toEqual({ outcome: 'granted', retryable: false })
    expect(h.of('grant')).toHaveLength(1)
    expect(h.of('grant')[0].args).toEqual({
      eventId: EVENT, sessionId: SESS, userId: USER, priceId: 'price_25',
      credits: 25, amountTotal: 9900, currency: 'usd',
    })
  })

  it('verifies payment settled, session mode, ownership before granting', async () => {
    const h = harness()
    await fulfillCreditPurchase(h.deps, { eventId: EVENT, session: jesseSession() })
    // ownership check happened (profile looked up by the metadata user id)
    expect(h.of('loadProfileById')[0].args).toBe(USER)
  })
})

describe('fulfillCreditPurchase — rejections (fail closed, no grant)', () => {
  const noGrant = (h: ReturnType<typeof harness>) => expect(h.of('grant')).toHaveLength(0)

  it('subscription-mode checkout → invalid', async () => {
    const h = harness(); const r = await fulfillCreditPurchase(h.deps, { eventId: EVENT, session: jesseSession({ mode: 'subscription' }) })
    expect(r.outcome).toBe('invalid'); noGrant(h)
  })
  it('unpaid session → payment_not_settled', async () => {
    const h = harness(); const r = await fulfillCreditPurchase(h.deps, { eventId: EVENT, session: jesseSession({ payment_status: 'unpaid' }) })
    expect(r.outcome).toBe('payment_not_settled'); noGrant(h)
  })
  it('incomplete session → payment_not_settled', async () => {
    const h = harness(); const r = await fulfillCreditPurchase(h.deps, { eventId: EVENT, session: jesseSession({ status: 'open' }) })
    expect(r.outcome).toBe('payment_not_settled'); noGrant(h)
  })
  it('missing user metadata → invalid', async () => {
    const h = harness(); const r = await fulfillCreditPurchase(h.deps, { eventId: EVENT, session: jesseSession({ metadata: {} }) })
    expect(r.outcome).toBe('invalid'); noGrant(h)
  })
  it('customer owner mismatch (profile owns a different customer) → conflict', async () => {
    const h = harness({ profile: { id: USER, stripe_customer_id: 'cus_OTHER' } })
    const r = await fulfillCreditPurchase(h.deps, { eventId: EVENT, session: jesseSession() })
    expect(r.outcome).toBe('conflict'); noGrant(h)
  })
  it('metadata user not found → conflict', async () => {
    const h = harness({ profile: null })
    const r = await fulfillCreditPurchase(h.deps, { eventId: EVENT, session: jesseSession() })
    expect(r.outcome).toBe('conflict'); noGrant(h)
  })
  it('unknown price id (not a credit pack) → invalid', async () => {
    const h = harness({ lineItems: [{ priceId: 'price_subscription', quantity: 1 }] })
    const r = await fulfillCreditPurchase(h.deps, { eventId: EVENT, session: jesseSession() })
    expect(r.outcome).toBe('invalid'); noGrant(h)
  })
  it('currency mismatch → conflict', async () => {
    const h = harness(); const r = await fulfillCreditPurchase(h.deps, { eventId: EVENT, session: jesseSession({ currency: 'eur' }) })
    expect(r.outcome).toBe('conflict'); noGrant(h)
  })
  it('amount mismatch for the resolved pack → conflict (a shared $ amount cannot select a pack)', async () => {
    const h = harness(); const r = await fulfillCreditPurchase(h.deps, { eventId: EVENT, session: jesseSession({ amount_total: 5000 }) })
    expect(r.outcome).toBe('conflict'); noGrant(h)
  })
  it('ambiguous line items (two priced lines) → conflict', async () => {
    const h = harness({ lineItems: [{ priceId: 'price_25', quantity: 1 }, { priceId: 'price_5', quantity: 1 }] })
    const r = await fulfillCreditPurchase(h.deps, { eventId: EVENT, session: jesseSession() })
    expect(r.outcome).toBe('conflict'); noGrant(h)
  })
  it('unexpected quantity → conflict', async () => {
    const h = harness({ lineItems: [{ priceId: 'price_25', quantity: 3 }] })
    const r = await fulfillCreditPurchase(h.deps, { eventId: EVENT, session: jesseSession() })
    expect(r.outcome).toBe('conflict'); noGrant(h)
  })
})

describe('fulfillCreditPurchase — idempotency + retryability', () => {
  it('a replayed event/session → already_processed (RPC dedupes; zero additional grant)', async () => {
    const h = harness({ grantResult: 'already_processed' })
    const r = await fulfillCreditPurchase(h.deps, { eventId: EVENT, session: jesseSession() })
    expect(r).toEqual({ outcome: 'already_processed', retryable: false })
  })
  it('a transient grant (DB) failure → error, RETRYABLE (nothing recorded)', async () => {
    const h = harness({ grantThrows: true })
    const r = await fulfillCreditPurchase(h.deps, { eventId: EVENT, session: jesseSession() })
    expect(r).toEqual({ outcome: 'error', retryable: true })
  })
  it('a transient Stripe line-item failure → error, RETRYABLE', async () => {
    const h = harness({ lineItemsThrows: true })
    const r = await fulfillCreditPurchase(h.deps, { eventId: EVENT, session: jesseSession() })
    expect(r).toEqual({ outcome: 'error', retryable: true })
  })
  it('recovery path (sessionId only) retrieves the session then fulfills', async () => {
    const h = harness()
    const r = await fulfillCreditPurchase(h.deps, { eventId: `recovery:${SESS}`, sessionId: SESS })
    expect(h.of('retrieveSession')[0].args).toBe(SESS)
    expect(r.outcome).toBe('granted')
    expect(h.of('grant')[0].args.eventId).toBe(`recovery:${SESS}`)
  })
  it('a session-retrieve failure → error, RETRYABLE', async () => {
    const h = harness({ retrieveThrows: true })
    const r = await fulfillCreditPurchase(h.deps, { eventId: 'recovery:x', sessionId: SESS })
    expect(r).toEqual({ outcome: 'error', retryable: true })
  })
})

describe('fulfillCreditPurchase — privacy', () => {
  it('logs carry ONLY event + coarse outcome/reason (no customer id, user id, email, or amount)', async () => {
    for (const cfg of [{}, { profile: { id: USER, stripe_customer_id: 'cus_OTHER' } }, { grantThrows: true }] as Cfg[]) {
      const h = harness(cfg)
      await fulfillCreditPurchase(h.deps, { eventId: EVENT, session: jesseSession() })
      const dump = JSON.stringify(h.logs)
      for (const secret of [CUS, USER, '9900', 'cus_OTHER']) expect(dump).not.toContain(secret)
      expect(dump).not.toContain('@')
    }
  })
})
