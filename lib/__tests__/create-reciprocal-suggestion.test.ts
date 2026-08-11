import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createReciprocalSuggestion } from '@/lib/matching/createReciprocalSuggestion'

// In-memory model of the transactional RPC public.create_reciprocal_suggestion (migration 050):
// eligibility recheck → per-side CAPACITY → canonical claim → cooldown → both 'suggested' cards
// (batch_id NULL, pair_id shared, match_reason = the passed fit reason or NULL — NOT the label).
function fakeDb(cfg: {
  eligible?: Set<string>
  blockedOrMatched?: Set<string>
  cooldownKeys?: Set<string>
  maxCards?: number
  initialCards?: Record<string, number> // requester_id → existing active card count
} = {}) {
  const eligible = cfg.eligible ?? new Set(['a', 'b', 'x', 'y'])
  const max = cfg.maxCards ?? 2
  const cards: Record<string, number> = { ...(cfg.initialCards ?? {}) }
  const created = new Set<string>()
  const intro: any[] = []
  let rpcCalls = 0
  const key = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`)
  return {
    _intro: intro,
    _created: created,
    get rpcCalls() { return rpcCalls },
    rpc: async (fn: string, args: any) => {
      rpcCalls++
      if (fn !== 'create_reciprocal_suggestion') return { data: null, error: { message: 'unknown fn' } }
      const { a_id, b_id, p_reason } = args
      if (!a_id || !b_id || a_id === b_id) return { data: 'invalid', error: null }
      const k = key(a_id, b_id)
      const [lo, hi] = a_id < b_id ? [a_id, b_id] : [b_id, a_id]
      if (!(eligible.has(lo) && eligible.has(hi))) return { data: 'ineligible', error: null }
      if (cfg.blockedOrMatched?.has(k)) return { data: 'ineligible', error: null }
      if (created.has(k)) return { data: 'exists_active', error: null }
      if ((cards[a_id] ?? 0) >= max || (cards[b_id] ?? 0) >= max) return { data: 'capacity', error: null }
      if (cfg.cooldownKeys?.has(k)) return { data: 'cooldown', error: null }
      created.add(k)
      cards[a_id] = (cards[a_id] ?? 0) + 1
      cards[b_id] = (cards[b_id] ?? 0) + 1
      intro.push({ requester_id: a_id, target_user_id: b_id, status: 'suggested', is_admin_initiated: false, match_reason: p_reason ?? null, pair_id: k, batch_id: null })
      intro.push({ requester_id: b_id, target_user_id: a_id, status: 'suggested', is_admin_initiated: false, match_reason: p_reason ?? null, pair_id: k, batch_id: null })
      return { data: 'created', error: null }
    },
  }
}

describe('createReciprocalSuggestion — reciprocity, structured label, independent rows', () => {
  it('A↔B: both STANDARD suggestion cards (batch_id NULL), shared pair_id, match_reason NOT the label', async () => {
    const db = fakeDb()
    expect(await createReciprocalSuggestion(db as any, 'a', 'b')).toEqual({ ok: true, outcome: 'created' })
    const aToB = db._intro.find(x => x.requester_id === 'a')
    const bToA = db._intro.find(x => x.requester_id === 'b')
    expect(aToB.status).toBe('suggested')
    expect(aToB.is_admin_initiated).toBe(false)
    expect(aToB.batch_id).toBeNull()                 // pair-governed, not attached to a batch
    expect(aToB.pair_id).toBe(bToA.pair_id)          // shared stable identifier (the label source)
    expect(aToB.match_reason).toBeNull()             // label is NOT overloaded onto match_reason
  })
})

describe('createReciprocalSuggestion — de-dup, concurrency, capacity, outcomes', () => {
  it('REVERSED duplicate → exists_active, still one pair', async () => {
    const db = fakeDb()
    await createReciprocalSuggestion(db as any, 'a', 'b')
    expect(await createReciprocalSuggestion(db as any, 'b', 'a')).toEqual({ ok: false, outcome: 'exists_active' })
    expect(db._created.size).toBe(1)
  })
  it('CONCURRENT claims on the same pair → exactly ONE created', async () => {
    const db = fakeDb()
    const rs = await Promise.all([
      createReciprocalSuggestion(db as any, 'x', 'y'),
      createReciprocalSuggestion(db as any, 'y', 'x'),
    ])
    expect(rs.filter(r => r.ok).length).toBe(1)
  })
  it('TARGET already at capacity → capacity (no card created, nothing evicted)', async () => {
    const db = fakeDb({ initialCards: { b: 2 } }) // b already has 2 active cards (max)
    expect(await createReciprocalSuggestion(db as any, 'a', 'b')).toEqual({ ok: false, outcome: 'capacity' })
    expect(db._intro).toHaveLength(0)
  })
  it('INITIATOR at capacity → capacity (both sides respected)', async () => {
    const db = fakeDb({ initialCards: { a: 2 } })
    expect(await createReciprocalSuggestion(db as any, 'a', 'b')).toEqual({ ok: false, outcome: 'capacity' })
  })
  it('CONCURRENT capacity claims: a member with 1 free slot gets exactly ONE more card, not two', async () => {
    const db = fakeDb({ initialCards: { b: 1 } }) // b has room for exactly one more
    const rs = await Promise.all([
      createReciprocalSuggestion(db as any, 'x', 'b'),
      createReciprocalSuggestion(db as any, 'y', 'b'),
    ])
    expect(rs.filter(r => r.ok).length).toBe(1)             // only one fills b's last slot
    expect(rs.filter(r => r.outcome === 'capacity').length).toBe(1)
  })
  it('mixed tiers use the same per-member limit (tier-agnostic RECOMMENDATIONS_PER_BATCH)', async () => {
    // The cap is not tier-scaled (getActiveIntroCap ignores tier); the RPC receives one p_max_cards.
    const db = fakeDb({ maxCards: 2, initialCards: { b: 2 } })
    expect(await createReciprocalSuggestion(db as any, 'a', 'b')).toEqual({ ok: false, outcome: 'capacity' })
  })
  it('self / ineligible / cooldown / rpc-error handled', async () => {
    expect(await createReciprocalSuggestion(fakeDb() as any, 'a', 'a')).toEqual({ ok: false, outcome: 'invalid' })
    expect(await createReciprocalSuggestion(fakeDb({ eligible: new Set(['a']) }) as any, 'a', 'b')).toEqual({ ok: false, outcome: 'ineligible' })
    expect(await createReciprocalSuggestion(fakeDb({ cooldownKeys: new Set(['a:b']) }) as any, 'a', 'b')).toEqual({ ok: false, outcome: 'cooldown' })
    const errDb = { rpc: async () => ({ data: null, error: { message: 'boom' } }) }
    expect(await createReciprocalSuggestion(errDb as any, 'a', 'b')).toEqual({ ok: false, outcome: 'error' })
  })
})

describe('migration 050 — hardened DB guarantees (structural)', () => {
  const sql = readFileSync('supabase/migrations/050_member_pairs.sql', 'utf8')
  it('canonical + reversed/duplicate + self prevention', () => {
    expect(sql).toMatch(/CHECK \(user_a_id < user_b_id\)/)
    expect(sql).toMatch(/UNIQUE \(user_a_id, user_b_id\)/)
    expect(sql).toMatch(/ON CONFLICT \(user_a_id, user_b_id\) DO NOTHING/)
  })
  it('standard suggestion cards (not admin_pending), batch_id NULL, label NOT via match_reason', () => {
    expect(sql).toMatch(/'suggested', false, p_reason, pair\.id/)
    expect(sql).toMatch(/p_reason text DEFAULT NULL/)          // fit reason, not the label
    expect(sql).not.toMatch(/DEFAULT 'Introduced by Andrel'/)  // label is structural (pair_id)
  })
  it('transactional per-side CAPACITY (never exceed / evict), plus eligibility recheck', () => {
    expect(sql).toMatch(/p_max_cards integer DEFAULT 2/)
    expect(sql).toMatch(/a_cards >= p_max_cards OR b_cards >= p_max_cards/)
    expect(sql).toMatch(/RETURN 'capacity'/)
    expect(sql).toMatch(/blocked_users/)
    expect(sql).toMatch(/public\.matches/)
    expect(sql).toMatch(/FOR UPDATE/)
  })
  it('hardened security + idempotent + non-destructive + cooldown metadata', () => {
    expect(sql).toMatch(/SECURITY DEFINER/)
    expect(sql).toMatch(/SET search_path = ''/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, authenticated/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/)
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/)
    expect(sql).not.toMatch(/CREATE POLICY/)
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS/)
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION/)
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS/)
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/)
    expect(sql).toMatch(/last_recommended_at/)
  })
})
