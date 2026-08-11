import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  median, pairKey, countUniqueMatchedPairs, exposureStats, groupInvitees,
  classifyInvitations, classifyRecommendations, computeNeedsAttention, monitoringGaps,
  THRESHOLDS, type ActivationLookup, type DeliveryRow, type IntroRow, type PairRow,
} from '@/lib/admin/dashboardMetrics'
import { loadAdminDashboard, AdminAuthorizationError, QUERY_BUDGET, __resetMigrationHealthCache } from '@/lib/admin/dashboardData'
import { ADMIN_EMAIL } from '@/lib/matching/eligibility'

const H = 60 * 60 * 1000
const D = 24 * H
const NOW = Date.parse('2026-08-11T12:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

// ── generic helpers ──────────────────────────────────────────────────────────────────
describe('pure helpers', () => {
  it('median handles odd/even/empty', () => {
    expect(median([])).toBe(0)
    expect(median([5])).toBe(5)
    expect(median([1, 2, 3])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(3) // rounded (2.5→3)
  })
  it('pairKey is canonical and rejects self/invalid', () => {
    expect(pairKey('b', 'a')).toBe('a:b')
    expect(pairKey('a', 'b')).toBe('a:b')
    expect(pairKey('a', 'a')).toBeNull()
    expect(pairKey('a', null)).toBeNull()
  })
  it('countUniqueMatchedPairs dedupes a stray reverse row (unique-pair counting)', () => {
    const rows = [
      { user_a_id: 'a', user_b_id: 'b' },
      { user_a_id: 'b', user_b_id: 'a' }, // reverse duplicate
      { user_a_id: 'a', user_b_id: 'c' },
      { user_a_id: 'x', user_b_id: 'x' }, // self → ignored
    ]
    expect(countUniqueMatchedPairs(rows)).toBe(2)
  })
})

// ── invitations & activation: PEOPLE not attempts ────────────────────────────────────
describe('classifyInvitations — collapses attempts to unique invitees', () => {
  const activation: ActivationLookup = {
    byId: new Map([['u_signed', true], ['u_never', false]]),
    byEmail: new Map([['signed@x.com', true]]),
  }
  const base = { waitlistStatuses: ['pending', 'pending'], invitedTotal: 10, invitedTracked: 6, activation, activationAvailable: true, now: NOW }

  it('first invite + reminder to ONE person counts once in Delivered (not twice)', () => {
    const m = classifyInvitations({
      ...base,
      deliveries: [
        { status: 'delivered', purpose: 'first_invite', waitlist_id: 'w1', delivered_at: iso(3 * D), last_event_at: iso(3 * D) },
        { status: 'delivered', purpose: 'reminder', waitlist_id: 'w1', delivered_at: iso(1 * D), last_event_at: iso(1 * D) },
      ],
    })
    expect(m.delivered).toBe(1)          // one PERSON
    expect(m.attempts.total).toBe(2)     // two ATTEMPTS (operational)
    expect(m.attempts.delivered).toBe(2)
    expect(m.attempts.byPurpose).toEqual({ first_invite: 1, reminder: 1 })
  })

  it('failed attempt followed by a delivered resend → invitee is DELIVERED, not failed', () => {
    const m = classifyInvitations({
      ...base,
      deliveries: [
        { status: 'bounced', purpose: 'first_invite', waitlist_id: 'w2', last_event_at: iso(5 * D) },
        { status: 'delivered', purpose: 'access_resend', waitlist_id: 'w2', delivered_at: iso(1 * D), last_event_at: iso(1 * D) },
      ],
    })
    expect(m.delivered).toBe(1)
    expect(m.failed).toBe(0)
  })

  it('delivered attempt followed by a later complaint/bounce → invitee is FAILED (current state)', () => {
    const m = classifyInvitations({
      ...base,
      deliveries: [
        { status: 'delivered', waitlist_id: 'w3', delivered_at: iso(5 * D), last_event_at: iso(5 * D) },
        { status: 'complained', waitlist_id: 'w3', last_event_at: iso(1 * D) },
      ],
    })
    expect(m.delivered).toBe(0)
    expect(m.failed).toBe(1)
  })

  it('same email with different case collapses to ONE invitee', () => {
    const m = classifyInvitations({
      ...base,
      deliveries: [
        { status: 'delivered', recipient_email: 'Person@X.com', delivered_at: iso(2 * D), last_event_at: iso(2 * D) },
        { status: 'delivered', recipient_email: 'person@x.com ', delivered_at: iso(1 * D), last_event_at: iso(1 * D) },
      ],
    })
    expect(m.delivered).toBe(1)
  })

  it('activation join works via waitlist/auth-linked AND email-linked records', () => {
    const m = classifyInvitations({
      ...base,
      deliveries: [
        { status: 'delivered', auth_user_id: 'u_signed', delivered_at: iso(2 * H), last_event_at: iso(2 * H) }, // activated by id
        { status: 'delivered', recipient_email: 'signed@x.com', delivered_at: iso(2 * H), last_event_at: iso(2 * H) }, // activated by email
        { status: 'delivered', auth_user_id: 'u_never', delivered_at: iso(9 * D), last_event_at: iso(9 * D) }, // not activated → all buckets
      ],
    })
    expect(m.delivered).toBe(3)
    expect(m.activated).toBe(2)
    expect(m.conversionRate).toBe(67) // 2/3 → 67, denom = unique delivered invitees
    expect(m.conversionDenominator).toBe('unique_delivered_invitees')
    expect(m.notActivated24h).toBe(1); expect(m.notActivated3d).toBe(1); expect(m.notActivated7d).toBe(1)
  })

  it('unattributable rows (no waitlist/auth/email) are counted separately, never merged', () => {
    const m = classifyInvitations({ ...base, deliveries: [{ status: 'delivered', delivered_at: iso(1 * D) }] })
    expect(m.delivered).toBe(0)
    expect(m.unattributableAttempts).toBe(1)
  })

  it('activation source incomplete → activation figures are null (unavailable), not partial', () => {
    const m = classifyInvitations({
      ...base, activationAvailable: false,
      deliveries: [{ status: 'delivered', waitlist_id: 'w9', delivered_at: iso(2 * D) }],
    })
    expect(m.delivered).toBe(1)          // delivery counts still work
    expect(m.activated).toBeNull()
    expect(m.notActivated7d).toBeNull()
    expect(m.conversionRate).toBeNull()
    expect(m.activationAvailable).toBe(false)
  })

  it('historical invitations with no delivery record are UNKNOWN, not failures', () => {
    const m = classifyInvitations({ ...base, deliveries: [] })
    expect(m.historicalUnknown).toBe(4) // 10 invited − 6 tracked
  })
  it('no divide-by-zero: conversion is null when nothing delivered', () => {
    const m = classifyInvitations({ ...base, deliveries: [{ status: 'bounced', waitlist_id: 'w1' }] })
    expect(m.conversionRate).toBeNull()
  })
})

// ── recommendations & matching ───────────────────────────────────────────────────────
describe('classifyRecommendations', () => {
  const intros: IntroRow[] = [
    // member a: 2 active reciprocal suggestions → at capacity, exposure onto b & c
    { requester_id: 'a', target_user_id: 'b', status: 'suggested', pair_id: 'p1' },
    { requester_id: 'a', target_user_id: 'c', status: 'suggested', pair_id: 'p2' },
    // reciprocal back-cards
    { requester_id: 'b', target_user_id: 'a', status: 'suggested', pair_id: 'p1' },
    { requester_id: 'c', target_user_id: 'a', status: 'suggested', pair_id: 'p2' },
    // legacy one-sided (no pair_id)
    { requester_id: 'd', target_user_id: 'a', status: 'suggested', batch_id: 'batch1' },
    // expressed interest
    { requester_id: 'b', target_user_id: 'c', status: 'approved' },
  ]
  const pairs: PairRow[] = [
    { status: 'active', last_recommended_at: iso(1 * D) },   // fresh
    { status: 'active', last_recommended_at: iso(12 * D) },  // nearing (>=11, <14)
    { status: 'active', last_recommended_at: iso(20 * D) },  // overdue (>=14)
    { status: 'passed', last_recommended_at: iso(30 * D) },  // not active → ignored
  ]
  const eligibleIds = ['a', 'b', 'c', 'd', 'e'] // e has no rec
  const matchPairKeys = new Set(['a:b'])
  const m = classifyRecommendations({
    intros, pairs, eligibleIds, matchPairKeys, matchedPairCount: 1,
    meetingPairKeys: ['a:b', 'c:d'], now: NOW,
  })

  it('separates reciprocal (pair_id) from one-sided legacy suggestions', () => {
    expect(m.activeReciprocalSuggestions).toBe(4)
    expect(m.oneSidedLegacySuggestions).toBe(1)
  })
  it('eligible-without-rec and at-capacity use active outbound slots', () => {
    expect(m.eligibleWithoutRec).toBe(1)         // only 'e'
    expect(m.membersAtCapacity).toBe(1)          // 'a' has 2 (== RECOMMENDATIONS_PER_BATCH)
  })
  it('rotation windows: nearing vs overdue over ACTIVE pairs only', () => {
    expect(m.nearingRotation).toBe(1)
    expect(m.staleOverdue).toBe(1)
    expect(m.reciprocalPairsCreated).toBe(4)
  })
  it('interest, mutual matches, and match-attributed upcoming meetings', () => {
    expect(m.interestExpressed).toBe(1)
    expect(m.mutualMatches).toBe(1)
    expect(m.upcomingMeetingsFromMatches).toBe(1) // a:b is a match; c:d is not
  })
})

describe('exposureStats concentration', () => {
  it('flags an unhealthy concentration (max large AND a multiple of median)', () => {
    const s = exposureStats([0, 1, 1, 2, 12]) // median 1, max 12
    expect(s.median).toBe(1)
    expect(s.max).toBe(12)
    expect(s.concentrationAlert).toBe(true)
  })
  it('does NOT alarm on small, even pools', () => {
    const s = exposureStats([1, 1, 2, 2])
    expect(s.concentrationAlert).toBe(false)
  })
  it('does NOT alarm when the top count is below the floor', () => {
    expect(exposureStats([0, 0, 0, 3]).concentrationAlert).toBe(false) // 3 < EXPOSURE_ALERT_MIN(4)
  })
})

// ── Needs Attention thresholds ───────────────────────────────────────────────────────
describe('computeNeedsAttention', () => {
  it('surfaces pending migrations (incl. 048) even when every queue is empty', () => {
    const items = computeNeedsAttention({
      invitations: null, recommendations: null,
      pendingMigrations: [{ migration: '048_drop_profiles_last_active_at.sql', message: 'x', impact: 'finish rollout' }],
      webhookErrors: 0, operational: {},
    })
    expect(items.length).toBe(1)
    expect(items[0].id).toBe('mig-048_drop_profiles_last_active_at.sql')
  })
  it('orders by severity (high → medium → low) and applies documented thresholds', () => {
    const items = computeNeedsAttention({
      invitations: { failed: 2, deliveryStuck: 0, notActivated7d: 0, notActivated3d: 4 } as any,
      recommendations: { eligibleWithoutRec: 3, staleOverdue: 1, exposure: { concentrationAlert: false, max: 0, median: 0 } } as any,
      pendingMigrations: [], webhookErrors: 5,
      operational: { issues: 1, adminIntros: 2, batchNeedsReview: true },
    })
    const sevs = items.map((i) => i.severity)
    // no 'low' should appear before a 'high'
    const firstLow = sevs.indexOf('low'); const lastHigh = sevs.lastIndexOf('high')
    expect(lastHigh).toBeLessThan(firstLow === -1 ? Infinity : firstLow)
    expect(items.find((i) => i.id === 'inv-failed')?.severity).toBe('high')
    expect(items.find((i) => i.id === 'webhook-errors')?.severity).toBe('high')
    expect(items.find((i) => i.id === 'rec-none')?.severity).toBe('medium')
    // 3d bucket only fires when 7d is zero
    expect(items.find((i) => i.id === 'inv-na-3d')).toBeTruthy()
  })
  it('every actionable item carries a count, explanation, and link destination', () => {
    const items = computeNeedsAttention({ invitations: { failed: 1 } as any, operational: {} })
    for (const i of items) {
      expect(i.count).toBeGreaterThan(0)
      expect(i.explanation.length).toBeGreaterThan(0)
      expect(i.href.startsWith('/dashboard/admin') || i.href.startsWith('http')).toBe(true)
    }
  })
})

describe('monitoringGaps', () => {
  it('honestly names the sources with no telemetry (cron, rec-gen, auth 5xx)', () => {
    const ids = monitoringGaps().map((g) => g.id)
    expect(ids).toEqual(expect.arrayContaining(['gap-cron', 'gap-recgen', 'gap-auth']))
  })
})

// ── IO orchestration: partial failure, auth, query-count, no-secret ──────────────────
function fakeAdmin(tables: Record<string, any[]>, opts: { throwOn?: Set<string>; authFailPage?: number } = {}) {
  let fromCalls = 0
  let authPages = 0
  const aborted: string[] = []
  const api: any = {
    _fromCalls: () => fromCalls,
    _authPages: () => authPages,
    _aborted: () => aborted,
    from(table: string) {
      fromCalls++
      let rows = [...(tables[table] ?? [])]
      let head = false
      let sig: AbortSignal | null = null
      const b: any = {
        select(_c: string, o?: any) { head = !!o?.head; return b },
        eq(c: string, v: any) { rows = rows.filter((r) => r[c] === v); return b },
        is(c: string, v: any) { rows = rows.filter((r) => (v === null ? r[c] == null : r[c] === v)); return b },
        in(c: string, a: any[]) { rows = rows.filter((r) => a.includes(r[c])); return b },
        gte(c: string, v: any) { rows = rows.filter((r) => r[c] != null && r[c] >= v); return b },
        gt(c: string, v: any) { rows = rows.filter((r) => r[c] != null && r[c] > v); return b },
        or() { return b },
        order() { return b },
        limit(n: number) { rows = rows.slice(0, n); return b },
        not() { return b },
        abortSignal(s: AbortSignal) { sig = s; return b },
        then(res: any, rej: any) {
          if (sig?.aborted) { aborted.push(table); return Promise.reject(new Error('aborted')).then(res, rej) }
          if (opts.throwOn?.has(table)) return Promise.reject(new Error(`boom:${table}`)).then(res, rej)
          const payload = head ? { count: rows.length, data: null, error: null } : { data: rows, count: rows.length, error: null }
          return Promise.resolve(payload).then(res, rej)
        },
      }
      return b
    },
    // Migration-health probes call rpc() for kind:'function' expectations.
    rpc: async (_fn: string, _args?: any) => ({ data: null, error: null }),
    // Real paginating listUsers so pagination completeness is exercised.
    auth: { admin: { listUsers: async ({ page, perPage }: { page: number; perPage: number }) => {
      authPages++
      if (opts.authFailPage && page === opts.authFailPage) return { data: null, error: { message: `page ${page} failed` } }
      const all = tables.__authUsers ?? []
      const slice = all.slice((page - 1) * perPage, (page - 1) * perPage + perPage)
      return { data: { users: slice }, error: null }
    } } },
  }
  return api
}

const baseTables = () => ({
  profiles: [
    { id: 'a', account_status: 'active', profile_complete: true, is_test_account: false, is_admin: false, email: 'a@x.com', matching_paused: false },
    { id: 'b', account_status: 'active', profile_complete: true, is_test_account: false, is_admin: false, email: 'b@x.com', matching_paused: false },
  ],
  intro_requests: [{ requester_id: 'a', target_user_id: 'b', status: 'suggested', pair_id: 'p1' }],
  member_pairs: [{ status: 'active', last_recommended_at: iso(1 * D) }],
  matches: [{ user_a_id: 'a', user_b_id: 'b', status: 'active', removed_at: null }],
  meetings: [] as any[],
  messages: [] as any[],
  member_presence: [] as any[],
  invitation_deliveries: [{ status: 'delivered', delivered_at: iso(2 * H), auth_user_id: 'a', waitlist_id: 'w1' }],
  invitation_delivery_events: [{ result: 'applied', created_at: iso(2 * H) }],
  waitlist: [{ status: 'invited', id: 'w1', invited_at: iso(3 * D) }, { status: 'pending', id: 'w2', invited_at: null }],
  issue_reports: [{ status: 'new' }],
  concierge_requests: [] as any[],
  introduction_batches: [{ id: 'batch1', status: 'active' }],
  __authUsers: [{ id: 'a', email: 'a@x.com', last_sign_in_at: iso(1 * H) }, { id: 'b', email: 'b@x.com', last_sign_in_at: null }],
})

const OPTS = { now: NOW, adminEmail: ADMIN_EMAIL, env: { deployedSha: 'abc1234' } }

describe('loadAdminDashboard IO', () => {
  beforeEach(() => __resetMigrationHealthCache())

  it('all sections resolve on healthy data; deployed SHA passes through', async () => {
    const admin = fakeAdmin(baseTables())
    const d = await loadAdminDashboard(admin, OPTS)
    expect(d.invitations.ok && d.recommendations.ok && d.members.ok).toBe(true)
    expect(d.platform.deployedSha).toBe('abc1234')
    expect(d.platform.cronHistory.available).toBe(false)
    expect(d.platform.authErrors.available).toBe(false)
    if (d.members.ok) expect(d.members.data.activeConnections).toBe(1) // unique pair
  })

  it('partial failure is isolated — one broken table degrades ONLY its section', async () => {
    const admin = fakeAdmin(baseTables(), { throwOn: new Set(['member_pairs']) })
    const d = await loadAdminDashboard(admin, OPTS)
    expect(d.recommendations.ok).toBe(false)           // depends on member_pairs
    expect(d.invitations.ok).toBe(true)                // unaffected
    expect(d.members.ok).toBe(true)                    // unaffected
    // Needs Attention still built from surviving sections + migrations.
    expect(d.needsAttention.some((i) => i.id.startsWith('mig-048'))).toBe(true)
  })

  it('Needs Attention is non-empty when 048 is pending even if all queues are clean', async () => {
    const clean = baseTables()
    clean.waitlist = []; clean.invitation_deliveries = []; clean.intro_requests = []
    clean.issue_reports = []; clean.concierge_requests = []; clean.introduction_batches = []
    const admin = fakeAdmin(clean)
    const d = await loadAdminDashboard(admin, OPTS)
    expect(d.needsAttention.length).toBeGreaterThan(0)
    expect(d.needsAttention.some((i) => i.id.startsWith('mig-048'))).toBe(true)
  })
})

describe('admin authorization at the loader boundary', () => {
  it('a non-admin identity cannot invoke the loader (throws before any query)', async () => {
    const admin = fakeAdmin(baseTables())
    await expect(loadAdminDashboard(admin, { ...OPTS, adminEmail: 'attacker@example.com' })).rejects.toBeInstanceOf(AdminAuthorizationError)
    expect(admin._fromCalls()).toBe(0) // refused before touching data
  })
  it('a null/undefined identity is refused', async () => {
    const admin = fakeAdmin(baseTables())
    await expect(loadAdminDashboard(admin, { ...OPTS, adminEmail: null })).rejects.toBeInstanceOf(AdminAuthorizationError)
  })
  it('the admin identity is accepted (case/space-insensitive)', async () => {
    const admin = fakeAdmin(baseTables())
    const d = await loadAdminDashboard(admin, { ...OPTS, adminEmail: `  ${ADMIN_EMAIL.toUpperCase()} ` })
    expect(d.members.ok).toBe(true)
  })
})

describe('Auth pagination completeness', () => {
  const manyAuth = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `u${i}`, email: `u${i}@x.com`, last_sign_in_at: i === n - 1 ? iso(1 * H) : null }))

  it('exhausts every page for a population above the API page size (1500 users → all included)', async () => {
    const t = baseTables()
    t.__authUsers = manyAuth(1500)
    // A delivered invitee on the LAST page must be counted as activated → proves full exhaustion.
    t.invitation_deliveries = [{ status: 'delivered', delivered_at: iso(2 * H), auth_user_id: 'u1499', waitlist_id: 'w1' }]
    t.waitlist = [{ status: 'invited', id: 'w1', invited_at: iso(3 * D) }]
    const admin = fakeAdmin(t)
    const d = await loadAdminDashboard(admin, OPTS)
    expect(d.activation.complete).toBe(true)
    expect(admin._authPages()).toBeGreaterThanOrEqual(2)     // network scales by page (NOT constant)
    expect(d.activation.pages).toBeGreaterThanOrEqual(2)
    if (d.invitations.ok) expect(d.invitations.data.activated).toBe(1) // last-page user found
  })

  it('a failed MIDDLE page surfaces incomplete → activation figures unavailable (not partial)', async () => {
    const t = baseTables()
    t.__authUsers = manyAuth(1500)
    t.invitation_deliveries = [{ status: 'delivered', delivered_at: iso(2 * H), auth_user_id: 'u0', waitlist_id: 'w1' }]
    t.waitlist = [{ status: 'invited', id: 'w1', invited_at: iso(3 * D) }]
    const admin = fakeAdmin(t, { authFailPage: 2 })
    const d = await loadAdminDashboard(admin, OPTS)
    expect(d.activation.complete).toBe(false)
    if (d.invitations.ok) {
      expect(d.invitations.data.activationAvailable).toBe(false)
      expect(d.invitations.data.activated).toBeNull()          // NOT a partial count
      expect(d.invitations.data.delivered).toBe(1)             // delivery counts still available
    }
  })
})

describe('population consistency', () => {
  it('total ⊇ active ⊇ weekly-active; test + admin excluded; % uses matched populations', async () => {
    const t = baseTables()
    t.profiles = [
      { id: 'a', account_status: 'active', profile_complete: true, is_test_account: false, is_admin: false, email: 'a@x.com', matching_paused: false },
      { id: 'b', account_status: 'active', profile_complete: true, is_test_account: false, is_admin: false, email: 'b@x.com', matching_paused: false },
      { id: 'c', account_status: 'inactive', profile_complete: true, is_test_account: false, is_admin: false, email: 'c@x.com', matching_paused: false }, // real, not active
      { id: 't', account_status: 'active', profile_complete: true, is_test_account: true, is_admin: false, email: 't@x.com', matching_paused: false },  // test → excluded
      { id: 'adm', account_status: 'active', profile_complete: true, is_test_account: false, is_admin: true, email: 'adm@x.com', matching_paused: false }, // admin → excluded
    ]
    t.member_presence = [{ user_id: 'a', last_active_at: iso(1 * D) }, { user_id: 't', last_active_at: iso(1 * D) }] // 't' excluded from numerator
    const admin = fakeAdmin(t)
    const d = await loadAdminDashboard(admin, OPTS)
    expect(d.members.ok).toBe(true)
    if (d.members.ok) {
      const m = d.members.data
      expect(m.totalMembers).toBe(3)     // a,b,c (test+admin excluded)
      expect(m.activeMembers).toBe(2)    // a,b
      expect(m.activeLast7d).toBe(1)     // only 'a' (real+active+present); 't' excluded
      expect(m.activeLast7d).toBeLessThanOrEqual(m.activeMembers)
      expect(m.activeMembers).toBeLessThanOrEqual(m.totalMembers)
      expect(m.weeklyActivePct).toBe(50) // 1/2, same population
    }
  })
})

// ── BLOCKER 1: connected-identity invitee grouping ───────────────────────────────────
describe('BLOCKER 1 — connected-identity grouping', () => {
  const noAct: ActivationLookup = { byId: new Map(), byEmail: new Map() }

  it('waitlist-linked attempt + Auth-linked resend sharing an email → ONE invitee', () => {
    const r = groupInvitees([
      { status: 'bounced', waitlist_id: 'W', recipient_email: 'e@x.com', last_event_at: iso(5 * D) },
      { status: 'delivered', auth_user_id: 'A', recipient_email: 'e@x.com', delivered_at: iso(1 * D), last_event_at: iso(1 * D) },
    ])
    expect(r.invitees.length).toBe(1)
    expect(r.invitees[0].currentStatus).toBe('delivered') // derived AFTER merge
  })

  it('three-step transitive linking (W–E, E–A, A–W2) merges to one', () => {
    const r = groupInvitees([
      { status: 'accepted', waitlist_id: 'W', recipient_email: 'e@x.com', created_at: iso(9 * D) },
      { status: 'delivered', auth_user_id: 'A', recipient_email: 'e@x.com', delivered_at: iso(8 * D), last_event_at: iso(8 * D) },
      { status: 'delivered', auth_user_id: 'A', waitlist_id: 'W2', delivered_at: iso(1 * D), last_event_at: iso(1 * D) },
    ])
    expect(r.invitees.length).toBe(1)
  })

  it('case/whitespace-different emails link the same person', () => {
    const r = groupInvitees([
      { status: 'delivered', waitlist_id: 'W', recipient_email: 'Person@X.com ', delivered_at: iso(2 * D), last_event_at: iso(2 * D) },
      { status: 'delivered', auth_user_id: 'A', recipient_email: ' person@x.com', delivered_at: iso(1 * D), last_event_at: iso(1 * D) },
    ])
    expect(r.invitees.length).toBe(1)
  })

  it('two conflicting Auth IDs sharing one email do NOT merge (email reassigned)', () => {
    const r = groupInvitees([
      { status: 'delivered', auth_user_id: 'A1', recipient_email: 'e@x.com', delivered_at: iso(3 * D), last_event_at: iso(3 * D) },
      { status: 'delivered', auth_user_id: 'A2', recipient_email: 'e@x.com', delivered_at: iso(1 * D), last_event_at: iso(1 * D) },
    ])
    expect(r.invitees.length).toBe(2)
    expect(r.manualReview).toBe(0)
  })

  it('a conflicted-email-only attempt (no strong id) → manual review, never guessed', () => {
    const r = groupInvitees([
      { status: 'delivered', auth_user_id: 'A1', recipient_email: 'e@x.com', delivered_at: iso(3 * D), last_event_at: iso(3 * D) },
      { status: 'delivered', auth_user_id: 'A2', recipient_email: 'e@x.com', delivered_at: iso(2 * D), last_event_at: iso(2 * D) },
      { status: 'delivered', recipient_email: 'e@x.com', delivered_at: iso(1 * D) },
    ])
    expect(r.invitees.length).toBe(2)
    expect(r.manualReview).toBe(1)
  })

  it('changed email for the SAME Auth ID stays one invitee (auth id bridges)', () => {
    const r = groupInvitees([
      { status: 'bounced', auth_user_id: 'A', recipient_email: 'old@x.com', last_event_at: iso(5 * D) },
      { status: 'delivered', auth_user_id: 'A', recipient_email: 'new@x.com', delivered_at: iso(1 * D), last_event_at: iso(1 * D) },
    ])
    expect(r.invitees.length).toBe(1)
    expect(r.invitees[0].currentStatus).toBe('delivered')
  })

  it('unattributable attempts (no identifiers) are counted, not merged', () => {
    const r = groupInvitees([{ status: 'delivered', delivered_at: iso(1 * D) }, { status: 'failed' }])
    expect(r.invitees.length).toBe(0)
    expect(r.unattributable).toBe(2)
  })

  it('deterministic output regardless of input row order', () => {
    const rows: DeliveryRow[] = [
      { status: 'delivered', waitlist_id: 'W', recipient_email: 'e@x.com', delivered_at: iso(3 * D), last_event_at: iso(3 * D) },
      { status: 'bounced', auth_user_id: 'A', recipient_email: 'e@x.com', last_event_at: iso(1 * D) },
      { status: 'accepted', waitlist_id: 'W2', created_at: iso(2 * D) },
      { status: 'delivered', auth_user_id: 'B', delivered_at: iso(1 * D), last_event_at: iso(1 * D) },
    ]
    expect(JSON.stringify(groupInvitees([...rows].reverse()).invitees)).toBe(JSON.stringify(groupInvitees(rows).invitees))
  })

  it('delivered/failed precedence derived AFTER merging (later bounce beats earlier delivery)', () => {
    const m = classifyInvitations({
      deliveries: [
        { status: 'delivered', waitlist_id: 'W', delivered_at: iso(5 * D), last_event_at: iso(5 * D) },
        { status: 'bounced', waitlist_id: 'W', auth_user_id: 'A', recipient_email: 'e@x.com', last_event_at: iso(1 * D) },
      ],
      waitlistStatuses: [], invitedTotal: 0, invitedTracked: 0, activation: noAct, activationAvailable: true, now: NOW,
    })
    expect(m.delivered).toBe(0)
    expect(m.failed).toBe(1)
  })
})

// ── BLOCKER 2: query budget, shared reuse, cancellation, read-only ───────────────────
describe('BLOCKER 2 — query load', () => {
  beforeEach(() => __resetMigrationHealthCache())

  it('shared data requests stay within budget and DO NOT scale with volume', async () => {
    const small = await loadAdminDashboard(fakeAdmin(baseTables()), OPTS)
    expect(small.requestCount.data).toBeLessThanOrEqual(QUERY_BUDGET)

    const big = baseTables()
    big.profiles = Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, account_status: 'active', profile_complete: true, is_test_account: false, is_admin: false, email: `m${i}@x.com`, matching_paused: false }))
    big.intro_requests = Array.from({ length: 300 }, (_, i) => ({ requester_id: `m${i}`, target_user_id: `m${(i + 1) % 300}`, status: 'suggested', pair_id: `p${i}` }))
    const large = await loadAdminDashboard(fakeAdmin(big), OPTS)
    expect(large.requestCount.data).toBe(small.requestCount.data) // constant → shared loaders reused, no N+1
  })

  it('all sections resolve from ONE shared fetch (no duplicate profiles/matches/meetings reads)', async () => {
    const d = await loadAdminDashboard(fakeAdmin(baseTables()), OPTS)
    expect(d.members.ok && d.recommendations.ok && d.invitations.ok).toBe(true)
    // Pre-consolidation these three sections re-read profiles/matches/meetings; the budget proves reuse.
    expect(d.requestCount.data).toBe(QUERY_BUDGET)
  })

  it('migration health is cached: cold load probes, warm load does not', async () => {
    const cold = await loadAdminDashboard(fakeAdmin(baseTables()), OPTS)
    expect(cold.requestCount.migrationProbes).toBeGreaterThan(0)
    expect(cold.requestCount.warm).toBe(false)
    const warm = await loadAdminDashboard(fakeAdmin(baseTables()), OPTS)
    expect(warm.requestCount.migrationProbes).toBe(0)
    expect(warm.requestCount.warm).toBe(true)
  })

  it('a dashboard load performs NO writes (read-only, cannot trigger generation)', async () => {
    const writes: string[] = []
    const admin = fakeAdmin(baseTables())
    const orig = admin.from.bind(admin)
    admin.from = (t: string) => {
      const b = orig(t)
      for (const mth of ['insert', 'update', 'delete', 'upsert'] as const) (b as any)[mth] = () => { writes.push(`${t}.${mth}`); return b }
      return b
    }
    await loadAdminDashboard(admin, OPTS)
    expect(writes).toEqual([])
  })

  it('genuine cancellation: every shared query carries a real AbortSignal', async () => {
    const signals: any[] = []
    const admin = fakeAdmin(baseTables())
    const orig = admin.from.bind(admin)
    admin.from = (t: string) => {
      const b = orig(t)
      const oa = b.abortSignal.bind(b)
      b.abortSignal = (s: any) => { signals.push(s); return oa(s) }
      return b
    }
    await loadAdminDashboard(admin, OPTS)
    expect(signals.length).toBeGreaterThanOrEqual(QUERY_BUDGET) // wired to every shared query
    expect(signals.every((s) => s && typeof s.aborted === 'boolean')).toBe(true)
  })
})

// ── security: the metrics layer must never read secrets / tokens / raw payloads ──────
describe('no secret or raw-payload exposure', () => {
  const dataSrc = readFileSync('lib/admin/dashboardData.ts', 'utf8')
  const metricsSrc = readFileSync('lib/admin/dashboardMetrics.ts', 'utf8')
  it('does not select tokens, passwords, secrets, or raw webhook payloads', () => {
    for (const src of [dataSrc, metricsSrc]) {
      expect(src).not.toMatch(/\btoken\b|password|service_role_key|signing_secret|raw_payload|payload_json/i)
    }
  })
  it('reads webhook health from the coarse result column only', () => {
    expect(dataSrc).toContain("select('result, created_at')")
  })
})

describe('admin page — server-side gate, no client leak, no PII render (source)', () => {
  const page = readFileSync('app/dashboard/admin/page.tsx', 'utf8')
  it('gates at the page and re-checks admin at the loader', () => {
    expect(page).toContain('user.email !== ADMIN_EMAIL')
    expect(page).toContain('redirect(')
    expect(page).toContain('adminEmail: user.email') // loader re-authorization
  })
  it('is a server component and is never publicly cached', () => {
    expect(page).not.toMatch(/^['"]use client['"]/m)
    expect(page).toContain("export const dynamic = 'force-dynamic'")
  })
  it('invokes the data loader EXACTLY once (no double-render fetch)', () => {
    expect((page.match(/loadAdminDashboard\(/g) || []).length).toBe(1)
  })
  it('renders only aggregate numbers — no per-person PII fields or activation maps reach the tree', () => {
    // Guard against rendering DATA fields (not documentation): the page must never read a
    // recipient email, invitee email/id array, provider message id, or webhook payload.
    expect(page).not.toMatch(/\.recipient_email|\.emails\b|\.authIds\b|\.byEmail|\.byId|provider_message_id|svix_id|payload/i)
  })
})
