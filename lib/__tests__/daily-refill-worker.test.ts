import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextCreditRefillOn, effectiveCreditTier, REFILL_WORKER_LIMIT } from '@/lib/credits/monthlyRefill'

let workerAdmin: any
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => workerAdmin }))
import { GET } from '@/app/api/cron/daily-refill/route'

const TODAY = '2026-08-20'
const DUE = '2026-08-15'
const FUTURE = '2026-09-15'
const TIER: Record<string, number> = { free: 3, professional: 10, executive: 20, founding: 15 }
const NOW = new Date(`${TODAY}T12:00:00Z`)

// Faithful reference model of the migration-053 TIER-BOUND RPCs: claim resolves the effective tier
// server-side (effective_credit_tier mirror) and stores it as claimed_tier; apply takes NO tier, uses
// the stored claimed_tier, re-resolves the CURRENT tier and rejects drift, derives amount + next date,
// enforces the per-cycle UNIQUE ledger + lease ownership, and preserves premium exactly.
function makeRefillDb(seed: any[]) {
  const cycles = new Map<string, any>()
  const profiles = new Map<string, any>()
  const refills = new Set<string>()
  const credits = new Map<string, any>()
  const reads: string[] = []
  const claimArgs: any[] = []
  let clockMs = Date.parse(`${TODAY}T12:00:00Z`)
  let tok = 0
  credits.set('jesse', { free: 2, premium: 25, balance: 27, lifetime: 28 })

  for (const s of seed) {
    profiles.set(s.user_id, { is_founding_member: s.is_founding_member ?? false, founding_member_expires_at: s.founding_member_expires_at ?? null, subscription_tier: s.subscription_tier ?? 'free' })
    cycles.set(s.user_id, { next_refill_on: s.next_refill_on ?? DUE, anchor_day: s.anchor_day ?? 15, status: s.status ?? 'active', lease_token: null, lease_expires_at: null, claimed_tier: null })
  }
  const tierOf = (user: string) => effectiveCreditTier(profiles.get(user) ?? {}, NOW)

  const admin = {
    _clock: (ms?: number) => { if (ms != null) clockMs = ms; return clockMs },
    _cycles: () => cycles, _credits: () => credits, _refills: () => refills, _profiles: () => profiles,
    _reads: () => reads, _claimArgs: () => claimArgs,
    from(table: string) { reads.push(table); return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) } },
    rpc: async (fn: string, a: any) => {
      if (fn === 'claim_due_credit_refills') {
        claimArgs.push(a)
        const lim = Math.min(Math.max(a.p_limit ?? 0, 0), 200)
        const due = Array.from(cycles.entries())
          .filter(([, c]) => c.status === 'active' && c.next_refill_on <= TODAY && (c.lease_expires_at == null || c.lease_expires_at < clockMs))
          .sort((x, y) => x[1].next_refill_on.localeCompare(y[1].next_refill_on)).slice(0, lim)
        const rows = due.map(([user, c]) => {
          c.lease_token = `lt-${++tok}`
          c.lease_expires_at = clockMs + Math.min(Math.max(a.p_lease_seconds ?? 60, 1), 3600) * 1000
          c.claimed_tier = tierOf(user)                       // AUTHORITATIVE snapshot at claim time
          return { user_id: user, cycle_on: c.next_refill_on, lease_token: c.lease_token, claimed_tier: c.claimed_tier }
        })
        return { data: rows, error: null }
      }
      if (fn === 'apply_credit_refill') {
        // NOTE: no p_tier accepted — the DB uses the stored claimed_tier.
        const c = cycles.get(a.p_user_id)
        if (!c) return { data: 'stale_claim', error: null }
        if (c.lease_token == null || c.lease_token !== a.p_lease_token || c.lease_expires_at == null || c.lease_expires_at < clockMs) return { data: 'stale_claim', error: null }
        if (a.p_cycle_on !== c.next_refill_on) return { data: 'stale_claim', error: null }
        if (c.next_refill_on > TODAY) return { data: 'not_due', error: null }
        // TIER DRIFT: re-resolve current tier; reject + release lease if it changed since claim.
        const current = tierOf(a.p_user_id)
        if (current !== c.claimed_tier) { c.lease_token = null; c.lease_expires_at = null; c.claimed_tier = null; return { data: 'stale_claim', error: null } }
        const included = TIER[c.claimed_tier]
        if (included == null) return { data: 'invalid_tier', error: null }
        const next = nextCreditRefillOn(c.anchor_day, new Date(`${TODAY}T00:00:00Z`))
        const key = `${a.p_user_id}:${c.next_refill_on}`
        if (refills.has(key)) { c.next_refill_on = c.next_refill_on > next ? c.next_refill_on : next; c.lease_token = null; c.lease_expires_at = null; return { data: 'already_processed', error: null } }
        refills.add(key)
        const prev = credits.get(a.p_user_id) ?? { free: 0, premium: 0, balance: 0, lifetime: 0 }
        const premium = prev.premium ?? 0
        credits.set(a.p_user_id, { free: included, premium, balance: included + premium, lifetime: prev.lifetime ?? 0 })
        c.last_refill_on = c.next_refill_on; c.next_refill_on = next; c.lease_token = null; c.lease_expires_at = null
        return { data: 'refilled', error: null }
      }
      if (fn === 'park_credit_cycle') {
        const c = cycles.get(a.p_user_id)
        if (!c || c.lease_token == null || c.lease_token !== a.p_lease_token || c.lease_expires_at == null || c.lease_expires_at < clockMs || a.p_cycle_on !== c.next_refill_on) return { data: 'stale_claim', error: null }
        c.status = 'needs_review'; c.lease_token = null; c.lease_expires_at = null
        return { data: 'parked', error: null }
      }
      return { data: null, error: null }
    },
  }
  return admin
}

const cronReq = () => ({ headers: new Headers({ authorization: `Bearer ${process.env.CRON_SECRET ?? ''}` }) }) as any
beforeEach(() => { process.env.CRON_SECRET = 'test-secret' })

describe('daily-refill worker route (tier-bound)', () => {
  it('rejects a request without the CRON secret', async () => {
    workerAdmin = makeRefillDb([])
    expect((await GET({ headers: new Headers({}) } as any)).status).toBe(401)
  })

  it('claims a bounded batch, never scans profiles, refills each member at its CLAIMED tier (founding=15)', async () => {
    workerAdmin = makeRefillDb([{ user_id: 'a', is_founding_member: true }, { user_id: 'b', subscription_tier: 'executive' }])
    const body = await (await GET(cronReq())).json()
    expect(workerAdmin._claimArgs()[0].p_limit).toBe(REFILL_WORKER_LIMIT)
    expect(workerAdmin._reads()).not.toContain('profiles')
    expect(body.claimed).toBe(2); expect(body.refilled).toBe(2)
    expect(workerAdmin._credits().get('a').free).toBe(15)
    expect(workerAdmin._credits().get('b').free).toBe(20)
  })

  it('REPLACES included credits and PRESERVES purchased (premium) credits', async () => {
    workerAdmin = makeRefillDb([{ user_id: 'jesse', is_founding_member: true }])
    await GET(cronReq())
    expect(workerAdmin._credits().get('jesse')).toMatchObject({ free: 15, premium: 25, balance: 40 })
  })

  it('a Free member is refilled at 3 — the worker cannot request Executive/Founding (apply takes no tier)', async () => {
    workerAdmin = makeRefillDb([{ user_id: 'f', subscription_tier: 'free' }])
    await GET(cronReq())
    expect(workerAdmin._credits().get('f').free).toBe(3)
  })

  it('an EXPIRED founding member is refilled at its non-founding sub allowance (professional=10)', async () => {
    workerAdmin = makeRefillDb([{ user_id: 'e', is_founding_member: true, founding_member_expires_at: '2020-01-01T00:00:00Z', subscription_tier: 'professional' }])
    await GET(cronReq())
    expect(workerAdmin._credits().get('e').free).toBe(10)
  })

  it('a repeated run grants once (schedule advanced → nothing due)', async () => {
    workerAdmin = makeRefillDb([{ user_id: 'a', subscription_tier: 'professional' }])
    expect((await (await GET(cronReq())).json()).refilled).toBe(1)
    const second = await (await GET(cronReq())).json()
    expect(second.claimed).toBe(0)
    expect(workerAdmin._credits().get('a').free).toBe(10)
  })

  it('unknown tier is PARKED (needs_review), grants nothing, not re-claimed (no hot loop)', async () => {
    workerAdmin = makeRefillDb([{ user_id: 'x', subscription_tier: 'legacy_platinum' }])
    const first = await (await GET(cronReq())).json()
    expect(first.needs_review).toBe(1); expect(first.refilled).toBe(0)
    expect(workerAdmin._credits().get('x')).toBeUndefined()
    expect((await (await GET(cronReq())).json()).claimed).toBe(0)
  })

  it('response carries ONLY aggregate counts — no member identifiers', async () => {
    const UID = 'd11d1c98-e016-497f-9308-e5a4f3caa146'
    workerAdmin = makeRefillDb([{ user_id: UID, subscription_tier: 'free' }])
    const body = await (await GET(cronReq())).json()
    expect(JSON.stringify(body)).not.toContain(UID)
    expect(Object.keys(body).sort()).toEqual(['already_processed', 'claimed', 'invalid_tier', 'needs_review', 'not_due', 'refilled', 'stale_claim', 'success', 'update_failed', 'worker_timed_out'])
  })
})

describe('apply_credit_refill contract — TIER-BOUND, cycle-bound, lease-owned (reference model)', () => {
  const setup = (seed?: any[]) => makeRefillDb(seed ?? [{ user_id: 'u', subscription_tier: 'professional', anchor_day: 15 }])
  const claimOne = async (db: any) => (await db.rpc('claim_due_credit_refills', { p_limit: 10, p_lease_seconds: 120 })).data[0]
  const apply = (db: any, m: any, over: any = {}) => db.rpc('apply_credit_refill', { p_user_id: 'u', p_cycle_on: m.cycle_on, p_lease_token: m.lease_token, ...over })

  it('refills the DB allowance for the CLAIMED tier and advances the schedule', async () => {
    const db = setup(); const m = await claimOne(db)
    expect(m.claimed_tier).toBe('professional')
    expect((await apply(db, m)).data).toBe('refilled')
    expect(db._credits().get('u').free).toBe(10)
    expect(db._cycles().get('u').next_refill_on).toBe('2026-09-15')
  })

  it('a Free claim CANNOT be applied as Executive or Founding (no tier arg exists; amount is bound)', async () => {
    const db = setup([{ user_id: 'u', subscription_tier: 'free' }]); const m = await claimOne(db)
    // Even passing a bogus p_tier is ignored by the RPC contract — the stored claimed_tier (free) wins.
    expect((await apply(db, m, { p_tier: 'executive' })).data).toBe('refilled')
    expect(db._credits().get('u').free).toBe(3)   // free 3, NOT 20/15
  })

  it('a TIER CHANGE between claim and apply is rejected (stale_claim), then a reclaim uses fresh tier', async () => {
    const db = setup([{ user_id: 'u', subscription_tier: 'professional' }]); const m = await claimOne(db)
    db._profiles().get('u').subscription_tier = 'executive'   // upgrade AFTER claim
    expect((await apply(db, m)).data).toBe('stale_claim')     // drift → reject + release
    expect(db._credits().get('u')).toBeUndefined()            // nothing granted
    const m2 = await claimOne(db)                             // reclaim re-snapshots
    expect(m2.claimed_tier).toBe('executive')
    expect((await apply(db, m2)).data).toBe('refilled')
    expect(db._credits().get('u').free).toBe(20)              // fresh authoritative tier
  })

  it('rejects a FABRICATED cycle date → stale_claim', async () => {
    const db = setup(); const m = await claimOne(db)
    expect((await apply(db, m, { p_cycle_on: '2020-01-01' })).data).toBe('stale_claim')
    expect(db._credits().get('u')).toBeUndefined()
  })
  it('rejects a NOT-DUE (future) cycle → not_due', async () => {
    const db = setup([{ user_id: 'u', subscription_tier: 'free', next_refill_on: FUTURE }])
    const c = db._cycles().get('u'); c.lease_token = 'lt-x'; c.lease_expires_at = db._clock() + 60000; c.claimed_tier = 'free'
    expect((await apply(db, { cycle_on: FUTURE, lease_token: 'lt-x' })).data).toBe('not_due')
  })
  it('rejects a WRONG lease token → stale_claim', async () => {
    const db = setup(); const m = await claimOne(db)
    expect((await apply(db, m, { p_lease_token: 'nope' })).data).toBe('stale_claim')
  })
  it('rejects an EXPIRED lease → stale_claim', async () => {
    const db = setup(); const m = await claimOne(db)
    db._clock(db._clock() + 10 * 60 * 1000)
    expect((await apply(db, m)).data).toBe('stale_claim')
  })
  it('unknown claimed tier → invalid_tier (no grant)', async () => {
    const db = setup([{ user_id: 'u', subscription_tier: 'legacy_gold' }])
    const c = db._cycles().get('u'); c.lease_token = 'lt-z'; c.lease_expires_at = db._clock() + 60000; c.claimed_tier = 'legacy_gold'
    expect((await apply(db, { cycle_on: DUE, lease_token: 'lt-z' })).data).toBe('invalid_tier')
    expect(db._credits().get('u')).toBeUndefined()
  })
  it('per-cycle ledger backstop: a pre-existing refill row → already_processed, no double grant', async () => {
    const db = setup(); const m = await claimOne(db)
    db._refills().add(`u:${m.cycle_on}`)
    expect((await apply(db, m)).data).toBe('already_processed')
    expect(db._credits().get('u')).toBeUndefined()
  })
  it('lease recovery: after a crash (lease expiry) the row is re-claimable and grants once', async () => {
    const db = setup(); const m = await claimOne(db)
    db._clock(db._clock() + 10 * 60 * 1000)
    const m2 = await claimOne(db)
    expect(m2.lease_token).not.toBe(m.lease_token)
    expect((await apply(db, m2)).data).toBe('refilled')
    expect(db._credits().get('u').free).toBe(10)
  })
})
