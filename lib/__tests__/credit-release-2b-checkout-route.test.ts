import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  authUser: { id: '1230d5b2-2f28-442a-bae0-1ba4f32cd7c4', email: 'member@example.com' } as any,
  profile: { stripe_customer_id: 'cus_existing', full_name: 'Member', is_founding_member: false, founding_member_expires_at: null, subscription_tier: 'free' },
  reserve: { outcome: 'reserved', reservation_id: '6f5a3028-ce18-4a25-96f9-d761066dfa19', headroom_after: 20 } as any,
  bind: 'bound' as any,
  released: [] as any[],
  calls: [] as string[],
  sessionCreate: vi.fn(),
  sessionExpire: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: state.authUser } }) } }),
}))
vi.mock('@/lib/profiles/serverProfile', () => ({
  readProfileById: async () => ({ ok: true, profile: state.profile }),
}))
vi.mock('@/lib/tier-override', () => ({ getEffectiveTier: () => 'free' }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: any) => {
      state.calls.push(name)
      if (name === 'reserve_credit_purchase') return { data: state.reserve, error: null }
      if (name === 'bind_credit_purchase_reservation') return { data: state.bind, error: null }
      if (name === 'release_credit_purchase_reservation') { state.released.push(args); return { data: 'released', error: null } }
      return { data: null, error: { code: 'unexpected' } }
    },
    from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }),
  }),
}))
vi.mock('@/lib/stripe', () => ({
  CREDIT_PACKS: [{ name: '5 Credits', priceId: 'price_5', credits: 5, amount: 25 }],
  stripe: {
    customers: { create: vi.fn() },
    checkout: { sessions: {
      create: (...args: any[]) => state.sessionCreate(...args),
      expire: (...args: any[]) => state.sessionExpire(...args),
    } },
  },
}))

import { POST } from '@/app/api/stripe/checkout/route'

const request = (body: unknown) => ({ json: async () => body }) as any

beforeEach(() => {
  state.reserve = { outcome: 'reserved', reservation_id: '6f5a3028-ce18-4a25-96f9-d761066dfa19', headroom_after: 20 }
  state.bind = 'bound'
  state.calls.length = 0
  state.released.length = 0
  state.sessionCreate.mockReset().mockResolvedValue({ id: 'cs_new', url: 'https://checkout.stripe.test/session' })
  state.sessionExpire.mockReset().mockResolvedValue({ id: 'cs_new', status: 'expired' })
})

describe('Release 2B checkout route', () => {
  it('rejects an unknown payment Price before reservation or Stripe', async () => {
    const response = await POST(request({ priceId: 'price_unknown', mode: 'payment' }))
    expect(response.status).toBe(400)
    expect(state.calls).toEqual([])
    expect(state.sessionCreate).not.toHaveBeenCalled()
  })

  it('returns a clear capacity message without creating a Stripe session', async () => {
    state.reserve = { outcome: 'at_capacity', headroom: 3 }
    const response = await POST(request({ priceId: 'price_5', mode: 'payment' }))
    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/up to 50 credits/i)
    expect(state.sessionCreate).not.toHaveBeenCalled()
  })

  it('reserves, creates a 30-minute checkout carrying the reservation, then binds before returning its URL', async () => {
    const response = await POST(request({ priceId: 'price_5', mode: 'payment' }))
    expect(response.status).toBe(200)
    expect(state.calls.slice(0, 2)).toEqual(['reserve_credit_purchase', 'bind_credit_purchase_reservation'])
    const params = state.sessionCreate.mock.calls[0][0]
    expect(params.metadata.credit_reservation_id).toBe(state.reserve.reservation_id)
    expect(params.client_reference_id).toBe(state.reserve.reservation_id)
    expect(params.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 29 * 60)
    expect((await response.json()).url).toMatch(/^https:\/\/checkout\.stripe\.test/)
  })

  it('expires the Stripe session and releases an unbound lease when binding conflicts', async () => {
    state.bind = 'conflict'
    const response = await POST(request({ priceId: 'price_5', mode: 'payment' }))
    expect(response.status).toBe(503)
    expect(state.sessionExpire).toHaveBeenCalledWith('cs_new')
    expect(state.released).toHaveLength(1)
    expect(state.released[0].p_reason).toBe('checkout_creation_failed')
  })

  it('retains the reservation if Stripe expiration cannot be confirmed', async () => {
    state.bind = 'conflict'
    state.sessionExpire.mockRejectedValue(new Error('network'))
    const response = await POST(request({ priceId: 'price_5', mode: 'payment' }))
    expect(response.status).toBe(503)
    expect(state.released).toHaveLength(0)
  })
})
