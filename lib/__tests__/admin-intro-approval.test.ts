import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  classifyIntro, decideAdminReject, bucketIntroRecords, introPairKey, isConsentStatus,
  bothMembersConsented, ADMIN_APPROVE_DISABLED_MSG,
  type IntroRow,
} from '@/lib/introRequests/classify'

// ── Mocks for the server-action tests ────────────────────────────────────────────────
// A configurable fake admin client that records every write (insert/update). finalizeMutualMatch
// is mocked so the "allow" path never performs real IO — and refusals prove ZERO writes.
let fake: { api: any; writes: string[]; fromCalls: () => number }
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => fake.api }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => fake.api }))
vi.mock('@/lib/introductions/finalizeMutualMatch', () => ({
  finalizeMutualMatch: vi.fn(async () => ({ status: 200, body: { matchId: 'match_1' } })),
}))
import { finalizeMutualMatch } from '@/lib/introductions/finalizeMutualMatch'
import { approveIntroRequest, rejectIntroRequest } from '@/lib/introRequests/index'

function makeFake(cfg: { row?: any; reverse?: any; matchRows?: any[]; companies?: any[] }) {
  const writes: string[] = []
  let fromCount = 0
  const api = {
    from(table: string) {
      fromCount++
      const q: any = { table, filters: {}, _in: {}, op: 'select' }
      const resolve = () => {
        if (table === 'matches') return { data: cfg.matchRows ?? [], error: null }
        if (table === 'profiles') return { data: cfg.companies ?? [], error: null }
        if (table === 'intro_requests') {
          if (q._in.status) return { data: cfg.reverse ?? null, error: null } // reverse-consent lookup
          return { data: cfg.row ?? null, error: null }                        // id fetch
        }
        return { data: null, error: null }
      }
      const b: any = {
        select() { return b },
        eq(c: string, v: any) { q.filters[c] = v; return b },
        in(c: string, a: any[]) { q._in[c] = a; return b },
        or(s: string) { q.or = s; return b },
        limit() { return b },
        update(patch: any) { q.op = 'update'; writes.push(`${table}.update`); q.patch = patch; return b },
        insert() { writes.push(`${table}.insert`); return Promise.resolve({ data: null, error: null }) },
        single() { return Promise.resolve(resolve()) },
        maybeSingle() { return Promise.resolve(resolve()) },
        then(res: any, rej: any) { return Promise.resolve(resolve()).then(res, rej) },
      }
      return b
    },
  }
  return { api, writes, fromCalls: () => fromCount }
}

const NOW = Date.parse('2026-08-11T12:00:00Z')

// ── Pure classifier ──────────────────────────────────────────────────────────────────
describe('classifyIntro', () => {
  const base = { status: 'suggested', pair_id: null, is_admin_initiated: false }
  it('matched wins over everything', () => {
    expect(classifyIntro({ ...base, pair_id: 'p1' }, { isMatched: true, counterpartConsented: true })).toBe('matched')
  })
  it('a pair_id row is reciprocal_live (never admin-actionable)', () => {
    expect(classifyIntro({ ...base, pair_id: 'p1' }, { isMatched: false, counterpartConsented: false })).toBe('reciprocal_live')
  })
  it('flagged non-pair → flagged_review', () => {
    expect(classifyIntro(base, { isMatched: false, counterpartConsented: false, flagged: true })).toBe('flagged_review')
  })
  it('admin-initiated non-pair → admin_review', () => {
    expect(classifyIntro({ ...base, is_admin_initiated: true }, { isMatched: false, counterpartConsented: false })).toBe('admin_review')
  })
  it('legacy pending (non-admin, no pair) → legacy_read_only', () => {
    expect(classifyIntro({ status: 'pending', pair_id: null, is_admin_initiated: false }, { isMatched: false, counterpartConsented: false })).toBe('legacy_read_only')
  })
})

describe('bothMembersConsented — the finalization invariant', () => {
  const A = 'A', B = 'B'
  const row = (r: string, t: string, s: string) => ({ requester_id: r, target_user_id: t, status: s })

  it('true only when BOTH members have an independent outbound consent/interest row', () => {
    expect(bothMembersConsented([row(A, B, 'approved'), row(B, A, 'approved')], A, B)).toBe(true)
    expect(bothMembersConsented([row(A, B, 'accepted'), row(B, A, 'pending')], A, B)).toBe(true) // legacy member interest
  })
  it('false when the ACTING member has not consented (admin substitution blocked)', () => {
    // acting A row is admin_pending (never accepted); B accepted. An admin click cannot fill A's consent.
    expect(bothMembersConsented([row(A, B, 'admin_pending'), row(B, A, 'approved')], A, B)).toBe(false)
  })
  it('false when the COUNTERPART has not expressed interest', () => {
    expect(bothMembersConsented([row(A, B, 'approved'), row(B, A, 'admin_pending')], A, B)).toBe(false)
    expect(bothMembersConsented([row(A, B, 'approved'), row(B, A, 'suggested')], A, B)).toBe(false)
    expect(bothMembersConsented([row(A, B, 'approved')], A, B)).toBe(false) // no counterpart row at all
  })
  it('is_admin_initiated / admin_pending / suggested are NEVER consent', () => {
    expect(bothMembersConsented([row(A, B, 'admin_pending'), row(B, A, 'admin_pending')], A, B)).toBe(false)
    expect(bothMembersConsented([row(A, B, 'suggested'), row(B, A, 'suggested')], A, B)).toBe(false)
  })
  it('withdrawal after an earlier check fails closed (acting row no longer consent)', () => {
    expect(bothMembersConsented([row(A, B, 'declined'), row(B, A, 'approved')], A, B)).toBe(false)
    expect(bothMembersConsented([row(A, B, 'passed'), row(B, A, 'approved')], A, B)).toBe(false)
  })
})

describe('decideAdminReject', () => {
  it('refuses reciprocal pair rows (never mutate pair state)', () => {
    expect(decideAdminReject({ pair_id: 'p1' })).toEqual({ allow: false, reason: 'reciprocal_pair' })
  })
  it('allows archiving a legacy/admin (non-pair) row', () => {
    expect(decideAdminReject({ pair_id: null })).toEqual({ allow: true })
  })
})

describe('isConsentStatus / introPairKey', () => {
  it('consent = approved/accepted only; pending/admin_pending/accepted_pending_payment are NOT', () => {
    expect(isConsentStatus('approved')).toBe(true)
    expect(isConsentStatus('accepted')).toBe(true)
    expect(isConsentStatus('pending')).toBe(false)
    expect(isConsentStatus('admin_pending')).toBe(false)
    expect(isConsentStatus('accepted_pending_payment')).toBe(false) // administrative/payment state, not consent
    expect(isConsentStatus('suggested')).toBe(false)
  })
  it('pair key is canonical', () => {
    expect(introPairKey('b', 'a')).toBe('a:b')
    expect(introPairKey('a', 'a')).toBeNull()
  })
})

// ── Page bucketing ───────────────────────────────────────────────────────────────────
describe('bucketIntroRecords', () => {
  const row = (o: Partial<IntroRow>): IntroRow => ({
    id: Math.random().toString(36).slice(2), status: 'pending', pair_id: null, is_admin_initiated: false,
    requester_id: 'x', target_user_id: 'y', ...o,
  })
  it('three structurally-equivalent legacy pending rows all land in legacy (read-only)', () => {
    const rows = [
      row({ id: 'l1', requester_id: 'a', target_user_id: 'b' }),
      row({ id: 'l2', requester_id: 'c', target_user_id: 'd' }),
      row({ id: 'l3', requester_id: 'e', target_user_id: 'f' }),
    ]
    const b = bucketIntroRecords(rows, [])
    expect(b.legacy.map((r) => r.id).sort()).toEqual(['l1', 'l2', 'l3'])
    expect(b.needsReview).toHaveLength(0)
    expect(b.reciprocalLive).toHaveLength(0)
    expect(b.legacy.every((r) => r.category === 'legacy_read_only')).toBe(true)
  })
  it('reciprocal directional rows (both sides) count as ONE pair', () => {
    const rows = [
      row({ id: 'r1', status: 'suggested', pair_id: 'p1', requester_id: 'a', target_user_id: 'b' }),
      row({ id: 'r2', status: 'suggested', pair_id: 'p1', requester_id: 'b', target_user_id: 'a' }),
    ]
    const b = bucketIntroRecords(rows, [])
    expect(b.counts.reciprocalRows).toBe(2)
    expect(b.counts.reciprocalPairs).toBe(1)
    expect(b.reciprocalLive).toHaveLength(1) // deduped card
  })
  it('mixed legacy / reciprocal / admin / matched enter the correct sections', () => {
    const rows = [
      row({ id: 'leg', status: 'pending', requester_id: 'a', target_user_id: 'b' }),                       // legacy
      row({ id: 'rec', status: 'suggested', pair_id: 'p1', requester_id: 'c', target_user_id: 'd' }),       // reciprocal
      row({ id: 'adm', status: 'admin_pending', is_admin_initiated: true, requester_id: 'e', target_user_id: 'f' }), // admin_review
      row({ id: 'mat', status: 'approved', requester_id: 'g', target_user_id: 'h' }),                       // matched (below)
    ]
    const b = bucketIntroRecords(rows, [{ user_a_id: 'g', user_b_id: 'h' }])
    expect(b.legacy.map((r) => r.id)).toEqual(['leg'])
    expect(b.reciprocalLive.map((r) => r.id)).toEqual(['rec'])
    expect(b.needsReview.map((r) => r.id)).toEqual(['adm'])
    expect(b.counts.connections).toBe(1) // g:h
  })
  it('deterministic regardless of input order', () => {
    const rows = [
      row({ id: 'r1', status: 'suggested', pair_id: 'p1', requester_id: 'a', target_user_id: 'b' }),
      row({ id: 'r2', status: 'suggested', pair_id: 'p1', requester_id: 'b', target_user_id: 'a' }),
      row({ id: 'a1', status: 'admin_pending', is_admin_initiated: true, requester_id: 'c', target_user_id: 'd' }),
    ]
    const fwd = bucketIntroRecords(rows, [])
    const rev = bucketIntroRecords([...rows].reverse(), [])
    expect(JSON.stringify(rev.reciprocalLive)).toBe(JSON.stringify(fwd.reciprocalLive))
  })
})

// ── Server actions: fail-closed, zero side effects ───────────────────────────────────
describe('approveIntroRequest — fully disabled / fail-closed', () => {
  beforeEach(() => { vi.clearAllMocks() })

  // The admin approve action is disabled: an admin click can never supply either member's consent,
  // and no product policy authorizes an admin-forced connection. It performs ZERO reads/writes and
  // never finalizes — for ANY input (legacy, reciprocal, or admin-initiated-with-one-consent).
  const inputs: Array<[string, any]> = [
    ['legacy one-sided (non-admin)', { id: 'x', requester_id: 'a', target_user_id: 'b', status: 'pending', pair_id: null, is_admin_initiated: false }],
    ['reciprocal pair_id', { id: 'x', requester_id: 'a', target_user_id: 'b', status: 'suggested', pair_id: 'p1', is_admin_initiated: false }],
    ['admin-initiated + one member consented', { id: 'x', requester_id: 'a', target_user_id: 'b', status: 'admin_pending', pair_id: null, is_admin_initiated: true }],
  ]
  for (const [label, row] of inputs) {
    it(`${label} → refused, zero reads/writes, no finalize (admin cannot supply consent)`, async () => {
      fake = makeFake({ row, reverse: { status: 'approved' }, matchRows: [], companies: [] })
      const res: any = await approveIntroRequest('x')
      expect(res.error).toBe(ADMIN_APPROVE_DISABLED_MSG)
      expect(res.success).toBeUndefined()
      expect(fake.fromCalls()).toBe(0)          // never touched the database at all
      expect(fake.writes).toEqual([])
      expect(finalizeMutualMatch).not.toHaveBeenCalled()
    })
  }

  it('a forged/direct server-action call still cannot connect anyone', async () => {
    fake = makeFake({ row: { id: 'x', requester_id: 'a', target_user_id: 'b', status: 'admin_pending', pair_id: null, is_admin_initiated: true }, reverse: { status: 'approved' }, matchRows: [] })
    const res: any = await approveIntroRequest('any-id')
    expect(res.error).toBe(ADMIN_APPROVE_DISABLED_MSG)
    expect(finalizeMutualMatch).not.toHaveBeenCalled()
  })
})

describe('rejectIntroRequest — scoped archival', () => {
  beforeEach(() => { vi.clearAllMocks() })
  it('refuses to reject a reciprocal (pair_id) row — pair state untouched', async () => {
    fake = makeFake({ row: { id: 'x', pair_id: 'p1' } })
    const res: any = await rejectIntroRequest('x')
    expect(res.error).toBeTruthy()
    expect(fake.writes).toEqual([])
  })
  it('archives a legacy (non-pair) row to rejected', async () => {
    fake = makeFake({ row: { id: 'x', pair_id: null } })
    const res: any = await rejectIntroRequest('x')
    expect(res.success).toBe(true)
    expect(fake.writes).toEqual(['intro_requests.update'])
  })
})

// ── Structural guards ────────────────────────────────────────────────────────────────
describe('structural safety guards', () => {
  const classifySrc = readFileSync('lib/introRequests/classify.ts', 'utf8')
  const indexSrc = readFileSync('lib/introRequests/index.ts', 'utf8')
  const finalizeSrc = readFileSync('lib/introductions/finalizeMutualMatch.ts', 'utf8')
  const pageSrc = readFileSync('app/dashboard/admin/intros/page.tsx', 'utf8')
  const clientSrc = readFileSync('components/AdminIntrosClient.tsx', 'utf8')

  it('classify.ts sends no email and does no IO', () => {
    expect(classifySrc).not.toMatch(/sendEmail|sendMail|resend|from\(/i)
  })
  it('approveIntroRequest is disabled — no finalizer, no raw match/notify/conversation/credit', () => {
    const fn = indexSrc.slice(indexSrc.indexOf('export async function approveIntroRequest'), indexSrc.indexOf('export async function rejectIntroRequest'))
    expect(fn).not.toMatch(/finalizeMutualMatch/)
    expect(fn).not.toMatch(/\.from\(/)
    expect(fn).toContain('ADMIN_APPROVE_DISABLED_MSG')
  })
  it('finalizeMutualMatch revalidates BOTH consents immediately before the transactional RPC', () => {
    const guardIdx = finalizeSrc.indexOf('bothMembersConsented(consentRows')
    const rpcIdx = finalizeSrc.indexOf("'consume_credits_and_create_match'")
    expect(guardIdx).toBeGreaterThan(-1)
    expect(rpcIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(rpcIdx) // consent check precedes the RPC
  })
  it('the admin page authenticates the admin BEFORE creating the service-role client', () => {
    const gateIdx = pageSrc.indexOf('user.email !== ADMIN_EMAIL')
    const adminClientIdx = pageSrc.indexOf('createAdminClient()')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(adminClientIdx).toBeGreaterThan(gateIdx) // service-role client only after the gate
  })
  it('the admin UI shows NO Approve button (only cancel/archive)', () => {
    expect(clientSrc).not.toMatch(/adminApproveIntro|handleApprove|>Approve</)
  })
})
