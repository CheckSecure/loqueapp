import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createReciprocalSuggestion, expireStaleReciprocalPairs } from '@/lib/matching/createReciprocalSuggestion'

// ── Faithful model of the two RPCs sharing one store, including PARTICIPANT advisory locking. ──
class Mutex {
  private locked = false
  private waiters: Array<() => void> = []
  async acquire() { if (!this.locked) { this.locked = true; return } await new Promise<void>(r => this.waiters.push(r)) }
  release() { const n = this.waiters.shift(); if (n) n(); else this.locked = false }
}

function fakeStore(cfg: { max?: number; initialCards?: Record<string, number> } = {}) {
  const max = cfg.max ?? 2
  const cards: Record<string, number> = { ...(cfg.initialCards ?? {}) }
  const pairStatus = new Map<string, string>()          // canonical key → member_pairs.status
  const rows: any[] = []                                 // intro_requests
  const lastRecommended = new Map<string, number>()      // canonical key → tick
  const matched = new Set<string>()                      // canonical keys with a formed match
  const mutex = new Map<string, Mutex>()
  const lockOf = (id: string) => { if (!mutex.has(id)) mutex.set(id, new Mutex()); return mutex.get(id)! }
  const ck = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`)
  const activeCards = (id: string) => rows.filter(r => r.requester_id === id && (r.status === 'suggested' || r.status === 'queued')).length

  const rpc = async (fn: string, args: any) => {
    if (fn === 'create_reciprocal_suggestion') {
      const { a_id, b_id, p_reason } = args
      if (!a_id || !b_id || a_id === b_id) return { data: 'invalid', error: null }
      const [lo, hi] = a_id < b_id ? [a_id, b_id] : [b_id, a_id]
      await lockOf(lo).acquire(); await lockOf(hi).acquire() // canonical order → deadlock-free
      try {
        const k = ck(a_id, b_id)
        // active card OR a recent 'passed' (cooldown) blocks re-pairing; 'expired' (rotation) is re-creatable.
        if (pairStatus.get(k) === 'active' || pairStatus.get(k) === 'passed') return { data: 'exists_active', error: null }
        await Promise.resolve() // TOCTOU window between capacity count and insert
        if (activeCards(a_id) >= max || activeCards(b_id) >= max) return { data: 'capacity', error: null }
        pairStatus.set(k, 'active'); lastRecommended.set(k, Date.now())
        cards[a_id] = (cards[a_id] ?? 0) + 1; cards[b_id] = (cards[b_id] ?? 0) + 1
        rows.push({ requester_id: a_id, target_user_id: b_id, status: 'suggested', pair_id: k, match_reason: p_reason ?? null })
        rows.push({ requester_id: b_id, target_user_id: a_id, status: 'suggested', pair_id: k, match_reason: p_reason ?? null })
        return { data: 'created', error: null }
      } finally { lockOf(hi).release(); lockOf(lo).release() }
    }
    if (fn === 'pass_reciprocal_pair') {
      const { p_pair_id: k, p_passer_id } = args
      const [ua, ub] = k.split(':')
      if (p_passer_id !== ua && p_passer_id !== ub) return { data: 'invalid', error: null }
      const [lo, hi] = ua < ub ? [ua, ub] : [ub, ua]
      await lockOf(lo).acquire(); await lockOf(hi).acquire()
      try {
        const counterpart = p_passer_id === ua ? ub : ua
        if (matched.has(k)) { pairStatus.set(k, 'matched'); return { data: 'matched', error: null } } // precedence
        rows.filter(r => r.pair_id === k && r.requester_id === p_passer_id && (r.status === 'suggested' || r.status === 'expired')).forEach(r => { r.status = 'passed' })
        rows.filter(r => r.pair_id === k && r.requester_id === counterpart && r.status === 'suggested').forEach(r => { r.status = 'expired' })
        if (pairStatus.get(k) !== 'matched') pairStatus.set(k, 'passed')
        return { data: 'passed', error: null }
      } finally { lockOf(hi).release(); lockOf(lo).release() }
    }
    if (fn === 'expire_stale_reciprocal_pairs') {
      let expired = 0
      for (const [k, st] of Array.from(pairStatus.entries())) {
        if (st !== 'active') continue
        const pairRows = rows.filter(r => r.pair_id === k)
        const suggested = pairRows.filter(r => r.status === 'suggested')
        if (suggested.length === 2) { suggested.forEach(r => { r.status = 'expired' }); pairStatus.set(k, 'expired'); expired++ }
      }
      return { data: expired, error: null }
    }
    return { data: null, error: { message: 'unknown fn' } }
  }
  return { rpc, _rows: rows, _activeCards: activeCards, _pairStatus: pairStatus, _matched: matched }
}

describe('reciprocal ROTATION lifecycle (Blocker 1)', () => {
  it('two untouched cards do NOT block a member forever — rotation frees capacity', async () => {
    const db = fakeStore()
    // Fill member B with two untouched reciprocal cards (from two initiators).
    await createReciprocalSuggestion(db as any, 'a', 'b')
    await createReciprocalSuggestion(db as any, 'c', 'b')
    expect(db._activeCards('b')).toBe(2)
    expect((await createReciprocalSuggestion(db as any, 'd', 'b')).outcome).toBe('capacity') // full

    // Weekly rotation expires the untouched stale pairs → capacity released → a new pair can form.
    const { expired } = await expireStaleReciprocalPairs(db as any)
    expect(expired).toBe(2)
    expect(db._activeCards('b')).toBe(0)                       // capacity released
    expect((await createReciprocalSuggestion(db as any, 'd', 'b')).outcome).toBe('created') // no longer blocked
  })

  it('rotation expires BOTH directions atomically (both cards disappear together)', async () => {
    const db = fakeStore()
    await createReciprocalSuggestion(db as any, 'a', 'b')
    await expireStaleReciprocalPairs(db as any)
    const pairRows = db._rows.filter((r: any) => r.pair_id === 'a:b')
    expect(pairRows).toHaveLength(2)
    expect(pairRows.every((r: any) => r.status === 'expired')).toBe(true) // both sides gone from 'suggested'
  })

  it("one side's meaningful activity PROTECTS the pair from rotation", async () => {
    const db = fakeStore()
    await createReciprocalSuggestion(db as any, 'a', 'b')
    // A expresses interest → A→B row becomes 'pending' (independent activity).
    db._rows.find((r: any) => r.requester_id === 'a').status = 'pending'
    const { expired } = await expireStaleReciprocalPairs(db as any)
    expect(expired).toBe(0)                                    // not both-'suggested' → protected
    expect(db._pairStatus.get('a:b')).toBe('active')
  })

  it('re-recommendation after rotation does NOT create duplicate ACTIVE cards', async () => {
    const db = fakeStore()
    await createReciprocalSuggestion(db as any, 'a', 'b')
    await expireStaleReciprocalPairs(db as any)               // pair now 'expired'
    // The pair may be re-recommended later; the model treats a non-active pair as re-creatable.
    const again = await createReciprocalSuggestion(db as any, 'a', 'b')
    expect(again.outcome).toBe('created')
    const active = db._rows.filter((r: any) => r.pair_id === 'a:b' && r.status === 'suggested')
    expect(active).toHaveLength(2)                            // exactly the two NEW cards, no duplicates
  })
})

describe('pair-aware PASS — terminally closes both sides (final blocker)', () => {
  const pass = (db: any, k: string, passer: string) => db.rpc('pass_reciprocal_pair', { p_pair_id: k, p_passer_id: passer })

  it('A passes → B no longer sees A; both capacities released; B NOT marked passed; passer audited', async () => {
    const db = fakeStore()
    await createReciprocalSuggestion(db as any, 'a', 'b')
    await pass(db, 'a:b', 'a')
    const aRow = db._rows.find((r: any) => r.requester_id === 'a' && r.pair_id === 'a:b')
    const bRow = db._rows.find((r: any) => r.requester_id === 'b' && r.pair_id === 'a:b')
    expect(aRow.status).toBe('passed')        // passer preserved for audit/cooldown
    expect(bRow.status).toBe('expired')       // counterpart neutrally closed — NOT 'passed'
    expect(db._activeCards('a')).toBe(0)      // capacity released, both sides
    expect(db._activeCards('b')).toBe(0)
    expect(db._pairStatus.get('a:b')).toBe('passed')
  })
  it('cooldown prevents immediate re-pairing after a pass', async () => {
    const db = fakeStore()
    await createReciprocalSuggestion(db as any, 'a', 'b')
    await pass(db, 'a:b', 'a')
    expect((await createReciprocalSuggestion(db as any, 'a', 'b')).outcome).toBe('exists_active')
  })
  it('simultaneous pass/pass → both rows recorded passed (idempotent, concurrency-safe)', async () => {
    const db = fakeStore()
    await createReciprocalSuggestion(db as any, 'a', 'b')
    await Promise.all([pass(db, 'a:b', 'a'), pass(db, 'a:b', 'b')])
    expect(db._rows.find((r: any) => r.requester_id === 'a' && r.pair_id === 'a:b').status).toBe('passed')
    expect(db._rows.find((r: any) => r.requester_id === 'b' && r.pair_id === 'a:b').status).toBe('passed')
    expect(db._pairStatus.get('a:b')).toBe('passed')
  })
  it('pass racing interest: interest recorded first is PRESERVED (not silently erased)', async () => {
    const db = fakeStore()
    await createReciprocalSuggestion(db as any, 'a', 'b')
    db._rows.find((r: any) => r.requester_id === 'b' && r.pair_id === 'a:b').status = 'pending' // B interested first
    await pass(db, 'a:b', 'a')
    expect(db._rows.find((r: any) => r.requester_id === 'b' && r.pair_id === 'a:b').status).toBe('pending') // preserved
    expect(db._pairStatus.get('a:b')).toBe('passed')
  })
  it('MATCH precedence: a late pass never destroys a match → returns matched, status matched', async () => {
    const db = fakeStore()
    await createReciprocalSuggestion(db as any, 'a', 'b')
    db._matched.add('a:b')
    const r = await pass(db, 'a:b', 'a')
    expect(r.data).toBe('matched')
    expect(db._pairStatus.get('a:b')).toBe('matched')
  })
  it('pass racing rotation → terminal either way, no suggested cards remain', async () => {
    const db = fakeStore()
    await createReciprocalSuggestion(db as any, 'a', 'b')
    await Promise.all([pass(db, 'a:b', 'a'), db.rpc('expire_stale_reciprocal_pairs', {})])
    expect(['passed', 'expired']).toContain(db._pairStatus.get('a:b'))
    expect(db._rows.filter((r: any) => r.pair_id === 'a:b' && r.status === 'suggested')).toHaveLength(0)
  })
})

describe('PARTICIPANT-SAFE capacity locking (Blocker 2)', () => {
  it('concurrent (A,B) and (C,B) with ONE B slot → exactly one pair created', async () => {
    const db = fakeStore({ initialCards: { b: 1 } }) // b has one free slot (max 2)... but B already has 1 real? use rows
    // Give B one existing active card so only one more fits.
    db._rows.push({ requester_id: 'b', target_user_id: 'z', status: 'suggested', pair_id: 'b:z' })
    const rs = await Promise.all([
      createReciprocalSuggestion(db as any, 'a', 'b'),
      createReciprocalSuggestion(db as any, 'c', 'b'),
    ])
    expect(rs.filter(r => r.ok).length).toBe(1)
    expect(rs.filter(r => r.outcome === 'capacity').length).toBe(1)
    expect(db._activeCards('b')).toBe(2) // never exceeded
  })
  it('concurrent reversed (A,B)/(B,A) → exactly one pair', async () => {
    const db = fakeStore()
    const rs = await Promise.all([
      createReciprocalSuggestion(db as any, 'a', 'b'),
      createReciprocalSuggestion(db as any, 'b', 'a'),
    ])
    expect(rs.filter(r => r.ok).length).toBe(1)
  })
  it('overlapping chains (A,B),(B,C),(C,A) do not deadlock (all resolve)', async () => {
    const db = fakeStore()
    const rs = await Promise.all([
      createReciprocalSuggestion(db as any, 'a', 'b'),
      createReciprocalSuggestion(db as any, 'b', 'c'),
      createReciprocalSuggestion(db as any, 'c', 'a'),
    ])
    expect(rs).toHaveLength(3) // completion proves no deadlock (canonical-order locking)
  })
  it('retries return a STABLE outcome', async () => {
    const db = fakeStore()
    expect((await createReciprocalSuggestion(db as any, 'a', 'b')).outcome).toBe('created')
    expect((await createReciprocalSuggestion(db as any, 'a', 'b')).outcome).toBe('exists_active')
    expect((await createReciprocalSuggestion(db as any, 'a', 'b')).outcome).toBe('exists_active')
  })
})

describe('migration 050 — rotation + participant locks (structural)', () => {
  const sql = readFileSync('supabase/migrations/050_member_pairs.sql', 'utf8')
  it('acquires BOTH participant advisory locks in canonical order before checks (schema-qualified)', () => {
    expect(sql).toMatch(/pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(lo::text, 0\)\)/)
    expect(sql).toMatch(/pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(hi::text, 0\)\)/)
    // locks precede the eligibility/capacity SELECTs
    expect(sql.indexOf('pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text')).toBeLessThan(sql.indexOf('a_cards >= p_max_cards'))
  })
  it('pair-aware rotation expires both directions + advances member_pairs.status', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.expire_stale_reciprocal_pairs/)
    expect(sql).toMatch(/status = 'expired'[\s\S]*WHERE pair_id = rec\.id AND status = 'suggested'/)
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/)
    expect(sql).toMatch(/status IN \('active','expired','passed','matched','blocked','ineligible','superseded'\)/)
  })
  it('pass_reciprocal_pair closes both sides + match precedence, SECURITY DEFINER + locked service_role', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.pass_reciprocal_pair/)
    // schema-qualified participant locks (both members), canonical
    expect(sql).toMatch(/pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(pair\.user_a_id::text, 0\)\)/)
    expect(sql).toMatch(/pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(pair\.user_b_id::text, 0\)\)/)
    // match precedence returns BEFORE any card mutation
    expect(sql.indexOf("RETURN 'matched'")).toBeLessThan(sql.indexOf('requester_id = p_passer_id'))
    // passer audited to 'passed'; counterpart neutrally 'expired' (NOT 'passed')
    expect(sql).toMatch(/status = 'passed'[\s\S]*requester_id = p_passer_id AND status IN \('suggested','expired'\)/)
    expect(sql).toMatch(/status = 'expired'[\s\S]*requester_id = counterpart AND status = 'suggested'/)
    // terminal pair status never overrides a match
    expect(sql).toMatch(/UPDATE public\.member_pairs SET status = 'passed' WHERE id = pair\.id AND status <> 'matched'/)
    // SECURITY DEFINER + empty search_path + least privilege
    expect(sql).toMatch(/pass_reciprocal_pair[\s\S]*SECURITY DEFINER/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.pass_reciprocal_pair\(uuid, uuid\) FROM PUBLIC, anon, authenticated/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.pass_reciprocal_pair\(uuid, uuid\) TO service_role/)
  })
})
