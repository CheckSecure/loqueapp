import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isActionableIncoming, fetchActionableIncomingInterest } from '@/lib/introductions/incomingInterest'
import { classifyIntro } from '@/lib/introRequests/classify'

const express = readFileSync('app/api/intro-requests/express-interest/route.ts', 'utf8')
const incoming = readFileSync('lib/introductions/incomingInterest.ts', 'utf8')

describe('one-sided reciprocal interest stays private', () => {
  // 1. No one-sided NOTIFICATION for a reciprocal (pair_id) row.
  it('express-interest sends NO interest_received/admin_intro_nudge for a pair_id row', () => {
    expect(express).toContain('pair_id') // pair_id is loaded on the row
    // the entire one-sided-notify block is gated on the row NOT being a reciprocal pair
    expect(express).toMatch(/if \(!introRequest\.pair_id\) \{[\s\S]*interest_received/)
    expect(express).toMatch(/if \(!introRequest\.pair_id\) \{[\s\S]*admin_intro_nudge/)
  })
  it('mutual reciprocal finalization is UNCHANGED (reverse row → canonical finalizer)', () => {
    expect(express).toMatch(/if \(reverseRequest\)[\s\S]{0,120}finalizeMutualMatch/)
  })
  it('expressing interest mutates only the EXPRESSER’s own row, never the other member’s card', () => {
    // STEP 2 updates the row by its own id (the expresser's card); B's suggested row is untouched.
    expect(express).toMatch(/update\(\{ status: 'approved'[\s\S]{0,80}\.eq\('id', introRequestId\)/)
  })

  // 2. No one-sided INCOMING-INTEREST card for a reciprocal row (the "Interested in you" surface).
  it('the incoming-interest query EXCLUDES reciprocal pairs (pair_id IS NULL)', () => {
    expect(incoming).toContain(".is('pair_id', null)")
  })
  it('isActionableIncoming rejects a reciprocal pair even when otherwise actionable', () => {
    const base = { status: 'approved', isAdminInitiated: false, hasMatch: false, requesterActive: true, sameCompany: false }
    expect(isActionableIncoming(base)).toBe(true)                          // legacy one-sided → actionable
    expect(isActionableIncoming({ ...base, isReciprocalPair: true })).toBe(false) // reciprocal → never surfaced
  })
  it('fetchActionableIncomingInterest returns nothing for a would-be reciprocal expresser', async () => {
    // Fake db honoring .is('pair_id', null): a pair_id row is filtered at the query.
    const rows = [{ id: 'r', requester_id: 'A', target_user_id: 'B', status: 'approved', is_admin_initiated: false, pair_id: 'p1', match_reason: null, requester: { id: 'A', account_status: 'active', company: 'X' } }]
    const db = {
      from() {
        const q: any = { _isNull: [] as string[] }
        const b: any = {
          select() { return b }, eq() { return b }, order() { return b }, or() { return b }, maybeSingle() { return Promise.resolve({ data: { company: 'Y' } }) },
          is(col: string) { q._isNull.push(col); return b },
          then(res: any) {
            // apply the pair_id IS NULL filter the real query uses
            const data = q._isNull.includes('pair_id') ? rows.filter((r) => r.pair_id == null) : rows
            return Promise.resolve({ data }).then(res)
          },
        }
        return b
      },
    }
    const items = await fetchActionableIncomingInterest(db, 'B')
    expect(items).toEqual([]) // A's reciprocal interest never reaches B
  })
})

describe('reciprocal pairs never enter legacy/admin one-sided handling', () => {
  it('a pair_id row classifies as reciprocal_live (never admin_review / approval queue)', () => {
    expect(classifyIntro({ status: 'suggested', pair_id: 'p1', is_admin_initiated: false }, { isMatched: false, counterpartConsented: false })).toBe('reciprocal_live')
  })
})

describe('presentation copy does not imply the other member was notified', () => {
  const page = readFileSync('app/dashboard/introductions/page.tsx', 'utf8')
  it('the reciprocal recommendations copy states interest stays private', () => {
    expect(page).not.toContain("we’ll let them know")
    expect(page).toContain('Your interest stays private')
  })
})
