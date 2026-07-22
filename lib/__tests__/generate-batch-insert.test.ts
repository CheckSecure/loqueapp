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
    expect(state.insertedBatch.algorithm_version).toBe('v3')
    expect(state.insertedBatch.scoring_model_version).toMatch(/^v\d/)
    expect(state.insertedBatch.algorithm_config).toBeTruthy()
    expect(state.insertedBatch.config_hash).toMatch(/^[0-9a-f]{8}$/)
    // API response surfaces the version to the admin.
    expect(body.algorithmVersion).toBe('v3')
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
