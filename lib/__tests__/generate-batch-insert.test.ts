import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MATCH_SCORE_MAX } from '@/lib/matching/score'
import { EXPOSURE_CONFIG } from '@/lib/matching/batch-scoring'
import { perRecipientIntroLimit } from '@/lib/matching/batch-limits'

/**
 * Integration test for the admin "Generate New Batch" path. Drives the real
 * route handler with mocked Supabase clients to prove:
 *  - a full batch inserts multiple suggestions with storable scores (incl. > 100,
 *    the value that used to overflow numeric(4,2));
 *  - a failed suggestion insert deletes the just-created batch (no orphan) — the
 *    retry-safety / idempotency fix.
 */

const state = vi.hoisted(() => ({
  profiles: [] as any[],
  introRequests: [] as any[],
  lastBatch: { batch_number: 2 } as any,
  batch: { id: 'batch-new-id', batch_number: 3 } as any,
  batchError: null as any,
  suggestionsError: null as any,
  insertedSuggestions: null as any[] | null,
  insertedBatch: null as any,
  deletedBatchIds: [] as string[],
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'admin', email: 'bizdev91@gmail.com' } } }) } }),
}))

vi.mock('@/lib/supabase/admin', () => {
  const resolve = (b: any) => {
    if (b._table === 'profiles') return { data: state.profiles, error: null }
    if (b._table === 'matches') return { data: [], error: null }
    if (b._table === 'intro_requests') return { data: state.introRequests, error: null }
    if (b._table === 'introduction_batches') {
      if (b._insert) { state.insertedBatch = b._insert; return { data: state.batch, error: state.batchError } }
      if (b._delete) { const id = (b._eqs.find((e: any) => e[0] === 'id') || [])[1]; state.deletedBatchIds.push(id); return { error: null } }
      return { data: state.lastBatch, error: null }
    }
    if (b._table === 'batch_suggestions') {
      if (b._insert) { state.insertedSuggestions = b._insert; return { error: state.suggestionsError } }
      return { data: [], error: null }
    }
    return { data: [], error: null }
  }
  const from = (table: string) => {
    const b: any = { _table: table, _insert: null, _delete: false, _eqs: [] }
    for (const m of ['select', 'neq', 'not', 'gte', 'order', 'limit']) b[m] = () => b
    b.eq = (col: string, val: any) => { b._eqs.push([col, val]); return b }
    b.insert = (rows: any) => { b._insert = rows; return b }
    b.delete = () => { b._delete = true; return b }
    b.single = () => Promise.resolve(resolve(b))
    b.then = (res: any, rej: any) => Promise.resolve(resolve(b)).then(res, rej)
    return b
  }
  return { createAdminClient: () => ({ from }) }
})

import { POST } from '@/app/api/admin/generate-batch/route'

// Three strongly-matching free-tier members. High boost_score pushes scoreMatch
// well past 100 (the old overflow point) — proving the widened column stores it.
function member(id: string): any {
  return {
    id, full_name: `M ${id}`, email: `${id}@x.com`, role_type: 'Founder', seniority: 'senior',
    mentorship_role: null, interests: ['tech', 'travel', 'music'], intro_preferences: ['Founder'],
    subscription_tier: 'free', looking_for: '', expertise: ['ai', 'saas'],
    networkValueScore: 80, responsivenessScore: 80, verification_status: 'verified',
    trust_score: 90, current_status: null, purposes: ['raise capital', 'hire'],
    city: 'NYC', state: 'NY', geographic_scope: 'us-wide', meeting_format_preference: 'both',
    open_to_business_solutions: false, boost_score: 60, is_priority: true, profile_complete: true,
    account_status: 'active', is_test_account: false, is_admin: false, matching_paused: false,
  }
}

const post = () => POST(new Request('http://localhost/api/admin/generate-batch', { method: 'POST' }) as any)

beforeEach(() => {
  state.profiles = [member('a'), member('b'), member('c')]
  state.introRequests = []
  state.batchError = null
  state.suggestionsError = null
  state.insertedSuggestions = null
  state.deletedBatchIds = []
})

describe('Generate New Batch — full insert', () => {
  it('inserts multiple suggestions with storable scores including values > 100', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.batchId).toBe('batch-new-id')
    expect(body.totalSuggestions).toBeGreaterThan(0)

    const rows = state.insertedSuggestions || []
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(Number.isFinite(r.match_score)).toBe(true)
      expect(r.match_score).toBeLessThanOrEqual(MATCH_SCORE_MAX)
      expect(r.match_score).toBeGreaterThanOrEqual(0)
      expect(r.score_bucket).toBeTruthy()
    }
    // At least one score exceeds the old numeric(4,2) ceiling (99.99).
    expect(Math.max(...rows.map((r: any) => r.match_score))).toBeGreaterThan(99.99)
    // No orphan cleanup on the happy path.
    expect(state.deletedBatchIds).toEqual([])
    // Batch is stamped with the algorithm version + config snapshot (reproducibility).
    expect(state.insertedBatch.algorithm_version).toBe('v3.3')
    expect(state.insertedBatch.scoring_model_version).toMatch(/^v\d/)
    expect(state.insertedBatch.algorithm_config).toBeTruthy()
    expect(state.insertedBatch.config_hash).toMatch(/^[0-9a-f]{8}$/)
    // API response surfaces the version to the admin.
    expect(body.algorithmVersion).toBe('v3.3')
    expect(body.configHash).toMatch(/^[0-9a-f]{8}$/)
  })

  it('deletes the orphan batch when suggestion insert fails (retry-safe, no partial data)', async () => {
    state.suggestionsError = { message: 'numeric field overflow' }
    const res = await post()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/Failed to insert suggestions/)
    // Compensating cleanup removed the just-created batch → no orphan left behind.
    expect(state.deletedBatchIds).toContain('batch-new-id')
  })

  it('aborts cleanly if the batch row cannot be created (no suggestions attempted)', async () => {
    state.batchError = { message: 'db down' }
    const res = await post()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/Failed to create batch/)
    expect(state.insertedSuggestions).toBeNull()
  })

  it('excluded accounts (test / admin / suspended / incomplete) never appear as recipient or candidate', async () => {
    state.profiles = [
      member('a'), member('b'), member('c'),
      { ...member('t'), is_test_account: true },                 // test/demo/seed
      { ...member('adm'), is_admin: true },                      // internal/admin
      { ...member('s'), account_status: 'suspended' },           // suspended/disabled
      { ...member('i'), profile_complete: false },               // incomplete onboarding
      { ...member('p'), matching_paused: true },                 // participation paused (migration 019)
    ]
    await post()
    const rows = state.insertedSuggestions || []
    const banned = new Set(['t', 'adm', 's', 'i', 'p'])
    // Never a recipient, never a candidate.
    expect(rows.some((r: any) => banned.has(r.recipient_id))).toBe(false)
    expect(rows.some((r: any) => banned.has(r.suggested_id))).toBe(false)
    // Only the 3 real members participate.
    for (const r of rows) { expect(['a', 'b', 'c']).toContain(r.recipient_id); expect(['a', 'b', 'c']).toContain(r.suggested_id) }
    expect(rows.length).toBeGreaterThan(0)
  })

  it('no recipient ever exceeds their per-batch tier limit (final invariant)', async () => {
    // A larger free-tier cohort so many candidates qualify for each recipient.
    state.profiles = Array.from({ length: 10 }, (_, i) => ({ ...member('m' + i), subscription_tier: 'free', company: 'co' + i }))
    await post()
    const counts: Record<string, number> = {}
    for (const r of state.insertedSuggestions || []) counts[r.recipient_id] = (counts[r.recipient_id] || 0) + 1
    // Nobody may receive more than the (launch-capped) free-tier limit, no matter
    // how many candidates qualify.
    expect(Math.max(...Object.values(counts))).toBeLessThanOrEqual(perRecipientIntroLimit('free'))
  })

  it('produces a fully RECIPROCAL graph — every edge is mutual, visibility == receipt, both ≤ cap', async () => {
    // Varied cohort, distinct companies so same-company never removes an edge.
    const roles = ['Founder', 'Investor', 'Operator', 'Advisor']
    state.profiles = Array.from({ length: 12 }, (_, i) => ({
      ...member(String.fromCharCode(97 + i)), id: 'm' + i, role_type: roles[i % roles.length],
      boost_score: 0, is_priority: false, company: 'co' + i,
      purposes: i % 2 ? ['networking', 'raise capital'] : ['networking', 'hire'],
    }))
    await post()
    const rows = state.insertedSuggestions!
    expect(rows.length).toBeGreaterThan(0)

    // Zero one-way recommendations: every directed row has its reverse.
    const directed = new Set(rows.map((r: any) => `${r.recipient_id}>${r.suggested_id}`))
    for (const r of rows) {
      expect(directed.has(`${r.suggested_id}>${r.recipient_id}`)).toBe(true)
    }

    // Per member: appears-in count (visibility) == receives count, and both ≤ cap.
    const appears: Record<string, number> = {}
    const receives: Record<string, number> = {}
    for (const r of rows) {
      receives[r.recipient_id] = (receives[r.recipient_id] || 0) + 1
      appears[r.suggested_id] = (appears[r.suggested_id] || 0) + 1
    }
    const cap = perRecipientIntroLimit('free')
    const ids = Array.from(new Set(Object.keys(appears).concat(Object.keys(receives))))
    for (const id of ids) {
      expect(appears[id] || 0).toBe(receives[id] || 0)
      expect(receives[id] || 0).toBeLessThanOrEqual(cap)
    }
  })

  it('is deterministic + repeatable and enforces safety invariants (v2 algorithm)', async () => {
    // A larger, varied cohort so the exposure cap and role caps actually engage.
    const roles = ['Founder', 'Investor', 'Operator', 'Advisor']
    state.profiles = Array.from({ length: 12 }, (_, i) => ({
      ...member(String.fromCharCode(97 + i)), id: 'm' + i, role_type: roles[i % roles.length],
      boost_score: 0, is_priority: false, company: 'co' + i,
      purposes: i % 2 ? ['networking', 'raise capital'] : ['networking', 'hire'],
    }))

    await post()
    const run1 = state.insertedSuggestions!.map((r: any) => `${r.recipient_id}|${r.suggested_id}|${r.match_score}|${r.position}`)
    state.insertedSuggestions = null
    await post()
    const run2 = state.insertedSuggestions!.map((r: any) => `${r.recipient_id}|${r.suggested_id}|${r.match_score}|${r.position}`)

    // Deterministic / repeatable
    expect(run2).toEqual(run1)

    const rows = state.insertedSuggestions!
    // No duplicates, no self-matches
    expect(new Set(rows.map((r: any) => r.recipient_id + '|' + r.suggested_id)).size).toBe(rows.length)
    expect(rows.filter((r: any) => r.recipient_id === r.suggested_id).length).toBe(0)
    // Optional hard exposure cap is OFF by default (continuous penalty only);
    // if a cap is ever configured, it must be respected.
    if (EXPOSURE_CONFIG.maxPerBatch != null) {
      const exp: Record<string, number> = {}
      for (const r of rows) exp[r.suggested_id] = (exp[r.suggested_id] || 0) + 1
      expect(Math.max(...Object.values(exp))).toBeLessThanOrEqual(EXPOSURE_CONFIG.maxPerBatch)
    }
  })
})

// Queue-history exclusion: a pair already presented via the queue (intro_requests)
// must never reappear in a freshly generated admin batch — while scoring, reciprocity,
// caps, and all other pairs are unaffected.
describe('Generate New Batch — intro_requests (queue) history exclusion', () => {
  const ir = (requester: string, target: string, status: string, batch_id: string | null = 'b1') => ({ requester_id: requester, target_user_id: target, status, batch_id })
  const hasEdge = (rows: any[], x: string, y: string) =>
    rows.some((r: any) => (r.recipient_id === x && r.suggested_id === y) || (r.recipient_id === y && r.suggested_id === x))
  const noDuplicatePairs = (rows: any[]) =>
    new Set(rows.map((r: any) => r.recipient_id + '|' + r.suggested_id)).size === rows.length

  it('baseline (no queue history): the a–b edge IS generated — behavior unchanged', async () => {
    await post()
    const rows = state.insertedSuggestions || []
    expect(hasEdge(rows, 'a', 'b')).toBe(true)
    expect(noDuplicatePairs(rows)).toBe(true)
  })

  it('a pair present in intro_requests cannot appear in the new batch (both directions removed)', async () => {
    state.introRequests = [ir('a', 'b', 'suggested')] // a↔b already in the queue
    await post()
    const rows = state.insertedSuggestions || []
    expect(rows.length).toBeGreaterThan(0) // batch is not degenerate
    // The excluded pair is gone in BOTH directions…
    expect(rows.some((r: any) => r.recipient_id === 'a' && r.suggested_id === 'b')).toBe(false)
    expect(rows.some((r: any) => r.recipient_id === 'b' && r.suggested_id === 'a')).toBe(false)
    // …no generated edge is ever the excluded {a,b} pair…
    for (const r of rows) expect([r.recipient_id, r.suggested_id].sort().join('|')).not.toBe('a|b')
    // …and other eligible members are still introduced (c still appears).
    expect(rows.some((r: any) => r.recipient_id === 'c' || r.suggested_id === 'c')).toBe(true)
    expect(noDuplicatePairs(rows)).toBe(true)
  })

  it('excludes across all queue history tiers (accepted/pending/approved/passed/queued/archived-with-batch)', async () => {
    for (const status of ['accepted', 'pending', 'approved', 'passed', 'queued', 'archived']) {
      state.introRequests = [ir('a', 'b', status)]
      state.insertedSuggestions = null
      await post()
      const rows = state.insertedSuggestions || []
      expect(hasEdge(rows, 'a', 'b')).toBe(false)      // excluded for this status
      expect(rows.length).toBeGreaterThan(0)           // other pairs still generated (non-degenerate)
    }
  })

  it('does NOT over-exclude: an archived backfill artifact (no batch_id) is not history', async () => {
    state.introRequests = [ir('a', 'b', 'archived', null)] // migration artifact
    await post()
    const rows = state.insertedSuggestions || []
    expect(hasEdge(rows, 'a', 'b')).toBe(true) // still eligible — artifact, never presented
  })

  it('reverse-direction history also excludes the pair (bidirectional)', async () => {
    state.introRequests = [ir('b', 'a', 'passed')] // stored as b→a
    await post()
    const rows = state.insertedSuggestions || []
    expect(hasEdge(rows, 'a', 'b')).toBe(false)
  })
})

// Availability tiers: never pair a member who has unresolved active intros with a
// fully-resolved member (asymmetric — resolved side sees/responds, unresolved side is
// blocked behind their queue). Both-resolved and both-unresolved pairs are unaffected.
describe('Generate New Batch — availability tiers (asymmetry guard)', () => {
  const hasEdge = (rows: any[], x: string, y: string) =>
    rows.some((r: any) => (r.recipient_id === x && r.suggested_id === y) || (r.recipient_id === y && r.suggested_id === x))
  const involves = (rows: any[], id: string) => rows.some((r: any) => r.recipient_id === id || r.suggested_id === id)
  // A 'suggested' row to an OUT-OF-POOL target makes that member "unresolved" without
  // creating any a/b/c pair history (so we isolate the tier rule from the exclusion rule).
  const unresolved = (member: string) => ({ requester_id: member, target_user_id: 'ext-' + member, status: 'suggested', batch_id: 'b1' })

  it('resolved ↔ unresolved pairs are BLOCKED (both directions)', async () => {
    state.introRequests = [unresolved('a')] // a unresolved; b, c resolved
    await post()
    const rows = state.insertedSuggestions || []
    expect(rows.length).toBeGreaterThan(0)
    expect(involves(rows, 'a')).toBe(false)     // a never paired with resolved b/c
    expect(hasEdge(rows, 'b', 'c')).toBe(true)  // resolved↔resolved still allowed
  })

  it('unresolved ↔ unresolved pairs remain possible (re-engagement preserved)', async () => {
    state.introRequests = [unresolved('a'), unresolved('b')] // a, b unresolved; c resolved
    await post()
    const rows = state.insertedSuggestions || []
    expect(hasEdge(rows, 'a', 'b')).toBe(true)  // both unresolved → allowed
    expect(hasEdge(rows, 'a', 'c')).toBe(false) // tier mismatch → blocked
    expect(hasEdge(rows, 'b', 'c')).toBe(false) // tier mismatch → blocked
  })

  it('resolved ↔ resolved pairs are unchanged when nobody is unresolved', async () => {
    state.introRequests = []
    await post()
    const withNone = (state.insertedSuggestions || []).map((r: any) => `${r.recipient_id}>${r.suggested_id}`).sort()
    expect(withNone.length).toBeGreaterThan(0)
    expect(hasEdge(state.insertedSuggestions || [], 'a', 'b')).toBe(true)
    // Re-run: identical output → the tier logic adds no restriction and no perturbation.
    state.insertedSuggestions = null
    await post()
    const rerun = (state.insertedSuggestions || []).map((r: any) => `${r.recipient_id}>${r.suggested_id}`).sort()
    expect(rerun).toEqual(withNone)
  })
})

// Partner-to-partner LAST-RESORT (two-pass selection) + two-intro coverage. LFP↔LFP is
// excluded from the primary pass and reintroduced only for members who cannot otherwise
// reach 2 intros; role diversity is a preference that must not strand a member below 2.
describe('Generate New Batch — partner two-pass fallback + coverage fill', () => {
  const hasEdge = (rows: any[], x: string, y: string) =>
    rows.some((r: any) => (r.recipient_id === x && r.suggested_id === y) || (r.recipient_id === y && r.suggested_id === x))
  const degree = (rows: any[], id: string) => rows.filter((r: any) => r.recipient_id === id).length
  // open_to_business_solutions:true so a law-firm (provider) member can be matched with a
  // non-partner buyer — otherwise the SEPARATE business-solution throttle (not the partner
  // rule under test) would block those edges and mask the behavior we're asserting.
  const withRole = (id: string, role: string, company?: string) => ({ ...member(id), id, role_type: role, company: company ?? ('co-' + id), open_to_business_solutions: true })

  it('partner WITH viable non-partner (GC/in-house) options → does NOT receive another partner', async () => {
    // Star: lp1 (firm B) has two dedicated non-partner options (gc1/gc2, firm A) plus the
    // partner lp2 (firm A). Same-company excludes every A↔A edge, so gc1/gc2 have spare
    // capacity for lp1 — lp1 reaches 2 via non-partners in pass 1, so pass 2 adds no partner.
    state.profiles = [
      withRole('lp1', 'Law Firm Partner', 'firm-B'),
      withRole('lp2', 'Law Firm Partner', 'firm-A'),
      withRole('gc1', 'General Counsel', 'firm-A'),
      withRole('gc2', 'In-House Counsel', 'firm-A'),
    ]
    await post()
    const rows = state.insertedSuggestions || []
    expect(hasEdge(rows, 'lp1', 'lp2')).toBe(false) // partner available but NOT chosen
    expect(hasEdge(rows, 'lp1', 'gc1')).toBe(true)  // non-partner options taken instead
    expect(hasEdge(rows, 'lp1', 'gc2')).toBe(true)
    expect(degree(rows, 'lp1')).toBe(2)
  })

  it('partner with NO viable non-partner option → partner↔partner ALLOWED (last resort)', async () => {
    state.profiles = [withRole('lp1', 'Law Firm Partner'), withRole('lp2', 'Law Firm Partner')]
    await post()
    const rows = state.insertedSuggestions || []
    expect(hasEdge(rows, 'lp1', 'lp2')).toBe(true) // fallback pass seats it when nothing else exists
  })

  it('partner reaches 2 via one non-partner + one partner (partner ONLY for the shortfall slot)', async () => {
    // lp1 (firm B) has exactly ONE non-partner option (gc1, firm A) and one partner (lp2,
    // firm A). Pass 1 gives lp1 the non-partner; pass 2 adds the partner for the 2nd slot.
    state.profiles = [
      withRole('lp1', 'Law Firm Partner', 'firm-B'),
      withRole('lp2', 'Law Firm Partner', 'firm-A'),
      withRole('gc1', 'General Counsel', 'firm-A'),
    ]
    await post()
    const rows = state.insertedSuggestions || []
    expect(hasEdge(rows, 'lp1', 'gc1')).toBe(true) // preferred non-partner taken first
    expect(hasEdge(rows, 'lp1', 'lp2')).toBe(true) // partner only to fill the remaining slot
    expect(degree(rows, 'lp1')).toBe(2)
  })

  it('role diversity cannot strand a member at 1 intro (coverage fill tops up the 2nd)', async () => {
    state.profiles = [
      withRole('m', 'Operator', 'm-co'),
      withRole('c1', 'Founder', 'shared-co'), // same company as c2 → c1↔c2 excluded, so m's
      withRole('c2', 'Founder', 'shared-co'), // only partners are two same-role Founders
    ]
    await post()
    const rows = state.insertedSuggestions || []
    // Graph's role-diversity cap (max 1 same role) would seat only 1; the fill seats both.
    expect(hasEdge(rows, 'm', 'c1')).toBe(true)
    expect(hasEdge(rows, 'm', 'c2')).toBe(true)
    expect(degree(rows, 'm')).toBe(2)
  })

  it('members with available candidates receive 2 (coverage) and never exceed 2 (cap)', async () => {
    const roles = ['Founder', 'Investor', 'Operator', 'Advisor']
    state.profiles = Array.from({ length: 6 }, (_, i) => withRole('u' + i, roles[i % roles.length]))
    await post()
    const rows = state.insertedSuggestions || []
    const ids = state.profiles.map((p: any) => p.id)
    for (const id of ids) expect(degree(rows, id)).toBeLessThanOrEqual(2) // 2-max preserved
    expect(ids.filter((id: string) => degree(rows, id) === 2).length).toBe(ids.length) // everyone reaches 2
  })
})

// Business-solution throttle — legal peer-networking exemption. A law firm (provider) may
// meet a GC / in-house counsel (buyer) WITHOUT a business-solution opt-in, because that is
// peer legal networking. Non-legal buyer↔provider stays throttled.
describe('Generate New Batch — legal peer exemption from BS throttle', () => {
  const hasEdge = (rows: any[], x: string, y: string) =>
    rows.some((r: any) => (r.recipient_id === x && r.suggested_id === y) || (r.recipient_id === y && r.suggested_id === x))
  // Explicit per-member opt-in so we can prove the exemption works WITHOUT opt-in.
  const withOpt = (id: string, role: string, company: string, opt: boolean) => ({ ...member(id), id, role_type: role, company, open_to_business_solutions: opt })

  it('Law Firm Partner + GC match WITHOUT business-solution opt-in (legal peer networking)', async () => {
    state.profiles = [
      withOpt('lp', 'Law Firm Partner', 'firm-A', false), // provider, no opt-in
      withOpt('gc', 'General Counsel', 'corp-B', false),   // buyer, no opt-in
    ]
    await post()
    const rows = state.insertedSuggestions || []
    expect(hasEdge(rows, 'lp', 'gc')).toBe(true) // exempt → allowed despite no opt-in
  })

  it('Law Firm Partner + non-legal, non-opted buyer STAYS throttled (no edge without opt-in)', async () => {
    state.profiles = [
      withOpt('lp', 'Law Firm Partner', 'firm-A', false), // provider
      withOpt('fnd', 'Founder', 'startup-B', false),       // non-legal buyer, NOT opted in
    ]
    await post()
    const rows = state.insertedSuggestions || []
    expect(hasEdge(rows, 'lp', 'fnd')).toBe(false) // throttle preserved for non-legal
  })

  it('same non-legal buyer matches the law firm once they DO opt in (throttle still governs non-legal)', async () => {
    state.profiles = [
      withOpt('lp', 'Law Firm Partner', 'firm-A', false),
      withOpt('fnd', 'Founder', 'startup-B', true), // opted in → provider may be shown
    ]
    await post()
    const rows = state.insertedSuggestions || []
    expect(hasEdge(rows, 'lp', 'fnd')).toBe(true)
  })
})
