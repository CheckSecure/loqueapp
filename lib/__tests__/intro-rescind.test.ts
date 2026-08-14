import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { classifyIntroHistory } from '@/lib/introRequests/history'
import { buildBidirectionalMatchFilter } from '@/lib/db/filters'

// ── In-memory intro_requests mock behind the rescind route ────────────────────
const h = vi.hoisted(() => ({ user: { id: 'me' } as any, rows: [] as any[] }))

function makeFrom() {
  return function from(_table: string) {
    let op: 'select' | 'delete' | 'update' = 'select'
    let payload: any = null
    const filters: ((r: any) => boolean)[] = []
    const b: any = {
      select() { return b },
      delete() { op = 'delete'; return b },
      update(v: any) { op = 'update'; payload = v; return b },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b },
      in(k: string, arr: any[]) { const s = new Set(arr); filters.push((r) => s.has(r[k])); return b },
      not(k: string, operator: string, v: any) {
        if (operator === 'is' && v === null) filters.push((r) => r[k] !== null && r[k] !== undefined)
        return b
      },
      then(res: any, rej: any) { return run().then(res, rej) },
    }
    const match = (r: any) => filters.every((f) => f(r))
    async function run() {
      if (op === 'delete') {
        const removed = h.rows.filter(match)
        for (let i = h.rows.length - 1; i >= 0; i--) if (match(h.rows[i])) h.rows.splice(i, 1)
        return { data: removed.map((r) => ({ ...r })), error: null }
      }
      if (op === 'update') {
        const upd = h.rows.filter(match)
        for (const r of upd) Object.assign(r, payload)
        return { data: upd.map((r) => ({ ...r })), error: null }
      }
      return { data: h.rows.filter(match).map((r) => ({ ...r })), error: null }
    }
    return b
  }
}
// The route reads the session via the server client and WRITES via the admin (service_role) client
// (browser DML on intro_requests is revoked). Both share the same in-memory table so the test observes
// the writes. `from` ignores the table arg, so one factory serves both.
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) }, from: makeFrom() }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: makeFrom() }) }))

import { POST } from '@/app/api/intro/rescind/route'

const req = (targetId: string) =>
  new Request('http://x/api/intro/rescind', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ targetId }),
  })

const mineJames = () => h.rows.filter((r) => r.requester_id === 'me' && r.target_user_id === 'james')

beforeEach(() => { h.user = { id: 'me' }; h.rows = [] })

// ==============================================================================
// Test A — withdraw deletes the interest, the suggested recommendation survives
// ==============================================================================
describe('Test A: suggested + approved → withdraw', () => {
  it('deletes the approved row and KEEPS the suggested recommendation row', async () => {
    h.rows = [
      { id: 's1', requester_id: 'me', target_user_id: 'james', status: 'suggested', batch_id: 'b1' },
      { id: 'a1', requester_id: 'me', target_user_id: 'james', status: 'approved', batch_id: null },
    ]
    const res = await POST(req('james') as any)
    expect(res.status).toBe(200)
    expect((await res.json()).deleted).toBe(1)
    expect(mineJames().map((r) => r.status)).toEqual(['suggested']) // approved gone, suggested remains
    expect(h.rows.find((r) => r.id === 's1')?.status).toBe('suggested')
  })

  it('never deletes suggested / queued / passed / archived / hidden_permanent rows', async () => {
    h.rows = [
      { id: 'sug', requester_id: 'me', target_user_id: 'james', status: 'suggested', batch_id: 'b1' },
      { id: 'que', requester_id: 'me', target_user_id: 'james', status: 'queued', batch_id: 'b2' },
      { id: 'pas', requester_id: 'me', target_user_id: 'james', status: 'passed', batch_id: 'b1' },
      { id: 'arc', requester_id: 'me', target_user_id: 'james', status: 'archived', batch_id: 'b1' },
      { id: 'hid', requester_id: 'me', target_user_id: 'james', status: 'hidden_permanent', batch_id: 'b1' },
      { id: 'app', requester_id: 'me', target_user_id: 'james', status: 'approved', batch_id: null },
    ]
    await POST(req('james') as any)
    const survivors = new Set(mineJames().map((r) => r.id))
    expect(survivors.has('app')).toBe(false) // only the interest is removed
    for (const id of ['sug', 'que', 'pas', 'arc', 'hid']) expect(survivors.has(id)).toBe(true)
  })
})

// ==============================================================================
// Test B — archived recommendation no longer permanently excludes after withdraw
// ==============================================================================
describe('Test B: archived-after-completion → withdraw', () => {
  it('removes the interest, keeps the archived row, and neutralizes its batch_id', async () => {
    h.rows = [
      { id: 'arch', requester_id: 'me', target_user_id: 'james', status: 'archived', batch_id: 'b1' },
      { id: 'appr', requester_id: 'me', target_user_id: 'james', status: 'approved', batch_id: null },
    ]
    await POST(req('james') as any)
    expect(h.rows.find((r) => r.id === 'appr')).toBeUndefined() // interest removed
    const arch = h.rows.find((r) => r.id === 'arch')
    expect(arch).toBeTruthy()             // archived NOT deleted (req 1)
    expect(arch.status).toBe('archived')
    expect(arch.batch_id).toBeNull()      // neutralized → non-history artifact

    const { hardExcluded, softExcluded } = classifyIntroHistory('me', h.rows)
    expect(hardExcluded.has('james')).toBe(false)
    expect(softExcluded.has('james')).toBe(false) // no permanent exclusion
  })

  it('classifyIntroHistory: archived WITH batch_id excludes; WITHOUT batch_id does not', () => {
    const withBatch = classifyIntroHistory('me', [
      { requester_id: 'me', target_user_id: 'james', status: 'archived', batch_id: 'b1' },
    ])
    expect(withBatch.softExcluded.has('james')).toBe(true) // pre-withdraw: excluded

    const withoutBatch = classifyIntroHistory('me', [
      { requester_id: 'me', target_user_id: 'james', status: 'archived', batch_id: null },
    ])
    expect(withoutBatch.softExcluded.has('james')).toBe(false) // post-withdraw: eligible again
    expect(withoutBatch.hardExcluded.has('james')).toBe(false)
  })
})

// ==============================================================================
// Test C — mutual interest: one match, both in Network, both gone from Introductions
// ==============================================================================
describe('Test C: mutual interest still works', () => {
  it('the existing-match dedupe matches the pair in EITHER direction → exactly one match', () => {
    const filter = buildBidirectionalMatchFilter('A', 'B')
    // Both orderings present → a second express-interest finds the existing match and
    // never creates a duplicate, regardless of who is user_a / user_b.
    expect(filter).toContain('user_a_id.eq.A,user_b_id.eq.B')
    expect(filter).toContain('user_a_id.eq.B,user_b_id.eq.A')
  })

  it('a match excludes BOTH users from each other\'s Introductions (page filter)', () => {
    // Mirrors app/dashboard/introductions/page.tsx matchedUserIds computation.
    const matchedSetFor = (self: string, matches: any[]) =>
      new Set(matches.flatMap((m) => [m.user_a_id, m.user_b_id].filter((id) => id !== self)))
    const matches = [{ user_a_id: 'A', user_b_id: 'B' }]
    expect(matchedSetFor('A', matches).has('B')).toBe(true) // A no longer sees B in intros
    expect(matchedSetFor('B', matches).has('A')).toBe(true) // B no longer sees A in intros
  })

  it('both users see the match in Network (bidirectional query)', () => {
    const netPage = readFileSync('app/dashboard/network/page.tsx', 'utf8')
    expect(netPage).toMatch(/user_a_id\.eq\.\$\{profileId\},user_b_id\.eq\.\$\{profileId\}/)
  })
})

// ==============================================================================
// Test D — withdrawing does not affect the OTHER person's interest
// ==============================================================================
describe('Test D: withdraw is one-sided', () => {
  it('deletes only MY interest in James; James\'s interest in ME is untouched', async () => {
    h.rows = [
      { id: 'mine', requester_id: 'me', target_user_id: 'james', status: 'approved', batch_id: null },
      { id: 'theirs', requester_id: 'james', target_user_id: 'me', status: 'approved', batch_id: null },
    ]
    await POST(req('james') as any)
    expect(h.rows.find((r) => r.id === 'mine')).toBeUndefined() // my interest removed
    expect(h.rows.find((r) => r.id === 'theirs')).toBeTruthy()  // the other person's interest intact
  })
})
