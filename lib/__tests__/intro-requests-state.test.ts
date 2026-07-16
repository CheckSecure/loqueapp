import { describe, it, expect } from 'vitest'
import {
  isExpressedStatus,
  expressedTargetIdSet,
  findReusableOutboundIntro,
  isBatchExcludingStatus,
  suggestedCardState,
  introSectionFor,
  BATCH_EXCLUDING_STATUSES,
} from '@/lib/introRequests/state'

describe('isExpressedStatus', () => {
  it('only pending/approved count as expressed interest', () => {
    expect(isExpressedStatus('pending')).toBe(true)
    expect(isExpressedStatus('approved')).toBe(true)
    for (const s of ['suggested', 'declined', 'passed', 'hidden', 'admin_pending', null, undefined, '']) {
      expect(isExpressedStatus(s as any)).toBe(false)
    }
  })
})

describe('expressedTargetIdSet — the single source of feed Pending state', () => {
  const outbound = [
    { target_user_id: 'james', status: 'approved' },
    { target_user_id: 'sara', status: 'pending' },
    { target_user_id: 'leo', status: 'suggested' },   // recommendation, NOT expressed
    { target_user_id: 'mia', status: 'declined' },     // terminal, NOT expressed
  ]
  it('includes only targets with an outbound pending/approved request', () => {
    const set = expressedTargetIdSet(outbound)
    expect(set.has('james')).toBe(true)
    expect(set.has('sara')).toBe(true)
    expect(set.has('leo')).toBe(false)  // a bare suggested row never counts
    expect(set.has('mia')).toBe(false)
  })
  it('dedupes duplicate rows for the same target (safe with duplicate intro records)', () => {
    const set = expressedTargetIdSet([
      { target_user_id: 'james', status: 'approved' },
      { target_user_id: 'james', status: 'approved' }, // duplicate row (the bug)
      { target_user_id: 'james', status: 'suggested' },
    ])
    expect(set.size).toBe(1)
    expect(set.has('james')).toBe(true)
  })
  it('is deterministic — same persisted rows yield the same set on reload', () => {
    expect(expressedTargetIdSet(outbound)).toEqual(expressedTargetIdSet(outbound))
  })
})

describe('findReusableOutboundIntro — idempotency (no duplicate rows)', () => {
  it('returns an existing pending/approved row so a repeat click reuses it', () => {
    const rows = [
      { id: 'r2', status: 'approved', created_at: '2026-07-15T17:04:00Z' },
      { id: 'r1', status: 'pending', created_at: '2026-07-15T12:00:00Z' },
    ]
    // earliest expressed row is chosen deterministically
    expect(findReusableOutboundIntro(rows)?.id).toBe('r1')
  })
  it('ignores suggested/declined rows (they are not reusable interest)', () => {
    expect(findReusableOutboundIntro([{ id: 's', status: 'suggested' }, { id: 'd', status: 'declined' }])).toBeNull()
  })
  it('returns null when there is no expressed interest yet (first click inserts)', () => {
    expect(findReusableOutboundIntro([])).toBeNull()
    expect(findReusableOutboundIntro(null)).toBeNull()
  })
})

describe('suggestedCardState — feed / pending / connected surfaces agree', () => {
  const expressed = new Set(['james'])
  const matched = new Set(['zoe'])
  it('shows "express" when there is no interest yet', () => {
    expect(suggestedCardState({ targetId: 'new', expressedTargetIds: expressed, matchedUserIds: matched })).toBe('express')
  })
  it('shows "pending" after one-sided interest (persists on reload, no Express interest again)', () => {
    expect(suggestedCardState({ targetId: 'james', expressedTargetIds: expressed, matchedUserIds: matched })).toBe('pending')
  })
  it('shows "connected" once a match exists (rendered in the network, not as a suggestion)', () => {
    expect(suggestedCardState({ targetId: 'zoe', expressedTargetIds: expressed, matchedUserIds: matched })).toBe('connected')
  })
  it('a target never shows "express" once interest is expressed', () => {
    expect(suggestedCardState({ targetId: 'james', expressedTargetIds: expressed, matchedUserIds: matched })).not.toBe('express')
  })
})

describe('introSectionFor — a target lands in exactly one page section', () => {
  const sec = (o: Partial<Parameters<typeof introSectionFor>[0]>) =>
    introSectionFor({ isMatched: false, hasOutboundExpressed: false, hasSuggestedRow: false, ...o })

  it('approved one-sided interest appears in Pending (regression: James Kahrs)', () => {
    // approved is an expressed status → hasOutboundExpressed true, no match
    expect(sec({ hasOutboundExpressed: true })).toBe('pending')
  })
  it('pending one-sided interest appears in Pending', () => {
    expect(sec({ hasOutboundExpressed: true })).toBe('pending')
  })
  it('suggested with no interest appears in Suggestions', () => {
    expect(sec({ hasSuggestedRow: true })).toBe('suggested')
  })
  it('approved + suggested duplicate pair appears only once — in Pending, never Suggestions', () => {
    const s = sec({ hasOutboundExpressed: true, hasSuggestedRow: true })
    expect(s).toBe('pending')
    expect(s).not.toBe('suggested')
  })
  it('matched pair appears only in Connections (never Pending or Suggestions)', () => {
    const s = sec({ isMatched: true, hasOutboundExpressed: true, hasSuggestedRow: true })
    expect(s).toBe('connected')
  })
  it('passed/declined/hidden-only rows appear nowhere active', () => {
    // no match, no expressed interest, no suggested row → 'none'
    expect(sec({})).toBe('none')
  })
})

// The Pending section is fed by the SAME expressed set the feed uses, so a row
// that is 'approved' (or 'pending') resolves to hasOutboundExpressed via the
// shared status predicate — proving feed and Pending derive from one source.
describe('Pending section and feed derive from the same persisted status set', () => {
  it("an 'approved' outbound row counts as expressed for BOTH surfaces", () => {
    const outbound = [{ target_user_id: 'james', status: 'approved' }]
    const expressed = expressedTargetIdSet(outbound)
    expect(expressed.has('james')).toBe(true) // drives Pending inclusion
    expect(introSectionFor({ isMatched: false, hasOutboundExpressed: expressed.has('james'), hasSuggestedRow: false })).toBe('pending')
  })
})

describe('batch cannot reintroduce a pending or connected pair', () => {
  it('the batch-exclusion set includes suggested/pending/approved (bound to the real matcher)', () => {
    expect(isBatchExcludingStatus('pending')).toBe(true)
    expect(isBatchExcludingStatus('approved')).toBe(true)
    expect(isBatchExcludingStatus('suggested')).toBe(true)
    expect(BATCH_EXCLUDING_STATUSES).toContain('pending')
    expect(BATCH_EXCLUDING_STATUSES).toContain('approved')
  })
  it('terminal/absent statuses do not exclude (so declined pairs can re-surface later)', () => {
    for (const s of ['declined', 'passed', 'hidden', '', null]) {
      expect(isBatchExcludingStatus(s as any)).toBe(false)
    }
  })
})
