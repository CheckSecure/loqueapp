import { describe, it, expect } from 'vitest'
import {
  isActiveReciprocalOpportunityRow, hasActiveReciprocalOpportunity, ACTIVE_RECIPROCAL_STATUSES,
} from '@/lib/introductions/activeReciprocalOpportunity'

const U = 'user-1', C = 'counterpart-1'

describe('active-opportunity status set — only statuses that occur for pair_id rows', () => {
  it('is exactly [suggested, approved]', () => {
    expect([...ACTIVE_RECIPROCAL_STATUSES]).toEqual(['suggested', 'approved'])
  })
})

describe('isActiveReciprocalOpportunityRow — current member-facing state only', () => {
  const row = (o: Partial<{ requester_id: string; pair_id: string | null; status: string }>) =>
    ({ requester_id: U, pair_id: 'p1', status: 'suggested', ...o })

  it('own suggested reciprocal row (rendered card) → true', () => {
    expect(isActiveReciprocalOpportunityRow(row({ status: 'suggested' }), U)).toBe(true)
  })
  it('own approved reciprocal row (live engagement) → true', () => {
    expect(isActiveReciprocalOpportunityRow(row({ status: 'approved' }), U)).toBe(true)
  })
  it('statuses that never occur for pair_id rows do NOT qualify (queued/pending/accepted/accepted_pending_payment)', () => {
    for (const s of ['queued', 'pending', 'accepted', 'accepted_pending_payment']) {
      expect(isActiveReciprocalOpportunityRow(row({ status: s }), U)).toBe(false)
    }
  })
  it('terminal-negative statuses (passed/expired/hidden/declined/rejected) → false', () => {
    for (const s of ['passed', 'expired', 'hidden', 'hidden_permanent', 'declined', 'rejected']) {
      expect(isActiveReciprocalOpportunityRow(row({ status: s }), U)).toBe(false)
    }
  })
  it('only the COUNTERPART’s row (requester=other) → false', () => {
    expect(isActiveReciprocalOpportunityRow(row({ requester_id: C }), U)).toBe(false)
  })
  it('an unrelated LEGACY row (pair_id NULL) → false', () => {
    expect(isActiveReciprocalOpportunityRow(row({ pair_id: null }), U)).toBe(false)
  })
})

function fakeAdmin(cfg: { rows?: any[]; matched?: any[] }) {
  return {
    from(table: string) {
      const b: any = {
        select: () => b, eq: () => b, not: () => b, in: () => b, or: () => b, limit: () => b,
        then: (res: any, rej: any) =>
          Promise.resolve({ data: table === 'intro_requests' ? (cfg.rows ?? []) : (cfg.matched ?? []), error: null }).then(res, rej),
      }
      return b
    },
  }
}

describe('hasActiveReciprocalOpportunity — completion proof', () => {
  it('an active reciprocal row exists → true', async () => {
    expect(await hasActiveReciprocalOpportunity(fakeAdmin({ rows: [{ status: 'suggested' }] }), U)).toBe(true)
  })
  it('no active row + MATCHED reciprocal pair → true', async () => {
    expect(await hasActiveReciprocalOpportunity(fakeAdmin({ rows: [], matched: [{ id: 'p' }] }), U)).toBe(true)
  })
  it('no active row + pair exists but both cards expired (no matched) → false', async () => {
    expect(await hasActiveReciprocalOpportunity(fakeAdmin({ rows: [], matched: [] }), U)).toBe(false)
  })
  it('member card passed / only counterpart card / hidden → the query returns nothing → false', async () => {
    expect(await hasActiveReciprocalOpportunity(fakeAdmin({ rows: [], matched: [] }), U)).toBe(false)
  })
})
