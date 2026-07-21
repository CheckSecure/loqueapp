import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MATCH_SCORE_MAX } from '@/lib/matching/score'

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
      if (b._insert) return { data: state.batch, error: state.batchError }
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
    account_status: 'active',
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
})
