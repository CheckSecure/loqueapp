import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fulfillCreditPurchase, type FulfillDeps, type SessionLike } from '@/lib/stripe/fulfillCreditPurchase'

// A faithful JS model of the migration-052 grant_credit_pack RPC: dual UNIQUE (event, session),
// atomic + null-safe. Proves that the webhook path and the recovery path — which call the SAME
// fulfillment + the SAME grant — can never double-grant, in any interleaving.
function ledger() {
  const grants: Array<{ event: string; session: string }> = []
  const bal = new Map<string, { free: number | null; premium: number | null; lifetime: number | null }>()
  const grant: FulfillDeps['grantLegacy'] = async (a) => {
    if (grants.some((g) => g.event === a.eventId)) return 'already_processed'   // event replay
    if (grants.some((g) => g.session === a.sessionId)) return 'already_processed' // session under any event
    grants.push({ event: a.eventId, session: a.sessionId })
    const prev = bal.get(a.userId) ?? { free: 0, premium: 0, lifetime: 0 }
    const free = prev.free ?? 0, premium = prev.premium ?? 0, life = prev.lifetime ?? 0
    bal.set(a.userId, { free, premium: premium + a.credits, lifetime: life + a.credits })
    return 'granted'
  }
  return { grant, grants, bal }
}

const USER = 'u-jesse'
const CUS = 'cus_V3'
const SESS = 'cs_live_x'
const REAL_EVENT = 'evt_real_1'
const session: SessionLike = {
  id: SESS, mode: 'payment', status: 'complete', payment_status: 'paid',
  currency: 'usd', amount_total: 9900, customer: CUS, metadata: { supabase_user_id: USER },
}

function deps(l: ReturnType<typeof ledger>): FulfillDeps {
  return {
    retrieveSession: async () => session,
    listLineItems: async () => [{ priceId: 'price_25', quantity: 1 }],
    loadProfileById: async (uid) => ({ id: uid, stripe_customer_id: CUS }),
    bindReservation: async () => 'bound',
    grantReserved: l.grant,
    grantLegacy: l.grant,
    creditPacks: [{ priceId: 'price_25', credits: 25, amount: 99 }],
    log: () => {},
  }
}

// The webhook drives fulfillment by the REAL event id; the recovery-by-session drives it by the stable
// synthetic id `recovery:<session>`. Session uniqueness is the cross-path backstop.
const viaWebhook = (l: ReturnType<typeof ledger>) => fulfillCreditPurchase(deps(l), { eventId: REAL_EVENT, session })
const viaRecovery = (l: ReturnType<typeof ledger>) => fulfillCreditPurchase(deps(l), { eventId: `recovery:${SESS}`, session })

describe('recovery ↔ webhook can never double-grant (session uniqueness is the backstop)', () => {
  it('webhook then recovery → one granted, one already_processed, +25 total', async () => {
    const l = ledger()
    expect((await viaWebhook(l)).outcome).toBe('granted')
    expect((await viaRecovery(l)).outcome).toBe('already_processed')
    expect(l.bal.get(USER)!.premium).toBe(25)
    expect(l.grants).toHaveLength(1)
  })
  it('recovery then webhook → one granted, one already_processed, +25 total', async () => {
    const l = ledger()
    expect((await viaRecovery(l)).outcome).toBe('granted')
    expect((await viaWebhook(l)).outcome).toBe('already_processed') // real event new, but SESSION conflicts
    expect(l.bal.get(USER)!.premium).toBe(25)
  })
  it('concurrent webhook + recovery → exactly one granted', async () => {
    const l = ledger()
    const [a, b] = await Promise.all([viaWebhook(l), viaRecovery(l)])
    const outcomes = [a.outcome, b.outcome].sort()
    expect(outcomes).toEqual(['already_processed', 'granted'])
    expect(l.bal.get(USER)!.premium).toBe(25)
  })
  it('the same real event delivered twice → grants once', async () => {
    const l = ledger()
    await viaWebhook(l); await viaWebhook(l)
    expect(l.bal.get(USER)!.premium).toBe(25)
  })
  it('the synthetic recovery id is stable — re-running recovery grants once', async () => {
    const l = ledger()
    await viaRecovery(l); await viaRecovery(l)
    expect(l.bal.get(USER)!.premium).toBe(25)
  })
  it('a later successful retry after an early failure grants exactly once (no poisoning)', async () => {
    const l = ledger()
    // First attempt: grant throws (transient) → error/retryable, nothing recorded.
    const flaky: FulfillDeps = { ...deps(l), grantLegacy: async () => { throw new Error('db down') } }
    expect((await fulfillCreditPurchase(flaky, { eventId: REAL_EVENT, session })).outcome).toBe('error')
    expect(l.grants).toHaveLength(0) // not poisoned — no ledger row
    // Retry succeeds.
    expect((await viaWebhook(l)).outcome).toBe('granted')
    expect(l.bal.get(USER)!.premium).toBe(25)
  })
})

describe('stripe_events never gates credit fulfillment or recovery', () => {
  it('neither the fulfillment module nor the recovery route reads/writes stripe_events', () => {
    const fulfillSrc = readFileSync('lib/stripe/fulfillCreditPurchase.ts', 'utf8')
    const recoverSrc = readFileSync('app/api/admin/stripe/recover-credit-purchase/route.ts', 'utf8')
    expect(fulfillSrc).not.toMatch(/stripe_events/)
    expect(recoverSrc).not.toMatch(/stripe_events/)
    // So a stripe_events row for the event (but no credit_grants row) cannot suppress recovery:
    // recovery's idempotency authority is credit_grants alone.
  })
})
