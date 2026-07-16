import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the admin client. createIntroRequest returns early after the dedupe query
// in both scenarios under test, so that first query is all we need to control.
const state = vi.hoisted(() => ({
  dedupeResult: { data: [] as any, error: null as any },
  insertCalled: false,
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      gte: () => builder,
      order: () => builder,
      limit: () => builder,
      insert: () => { state.insertCalled = true; return builder },
      single: () => Promise.resolve(state.dedupeResult),
      maybeSingle: () => Promise.resolve(state.dedupeResult),
      // Thenable: awaiting the (dedupe) chain resolves to the configured result.
      then: (res: any, rej: any) => Promise.resolve(state.dedupeResult).then(res, rej),
    }
    return { from: () => builder }
  },
}))

import { createIntroRequest } from '@/lib/introRequests'

beforeEach(() => {
  state.dedupeResult = { data: [], error: null }
  state.insertCalled = false
})

describe('createIntroRequest — idempotency', () => {
  it('reuses an existing pending/approved outbound row and does NOT insert a duplicate', async () => {
    state.dedupeResult = {
      data: [{ id: 'existing-approved', status: 'approved', created_at: '2026-07-15T17:04:00Z' }],
      error: null,
    }
    const res: any = await createIntroRequest('daniel', 'daniel@x.com', 'james')
    expect(res.success).toBe(true)
    expect(res.introRequestId).toBe('existing-approved')
    expect(res.alreadyExpressed).toBe(true)
    expect(state.insertCalled).toBe(false) // no duplicate row created on retry
  })

  it('rejects self-introductions before any write', async () => {
    const res: any = await createIntroRequest('daniel', 'daniel@x.com', 'daniel')
    expect(res.error).toBeTruthy()
    expect(state.insertCalled).toBe(false)
  })
})

describe('createIntroRequest — failed read/write never reports false success', () => {
  it('surfaces an error (not success) when the dedupe query errors', async () => {
    state.dedupeResult = { data: null, error: { message: 'db unavailable' } }
    const res: any = await createIntroRequest('daniel', 'daniel@x.com', 'james')
    expect(res.error).toBe('db unavailable')
    expect(res.success).toBeUndefined()
    expect(state.insertCalled).toBe(false)
  })
})
