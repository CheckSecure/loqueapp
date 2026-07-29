import { describe, it, expect, afterEach } from 'vitest'
import {
  classifyIntroHistory,
  exhaustionThreshold,
  HARD_HISTORY_STATUSES,
  isIntroHistoryRow,
  buildIntroHistoryExclusions,
} from '@/lib/introRequests/history'

const row = (requester_id: string, target_user_id: string, status?: string, batch_id?: string | null) =>
  ({ requester_id, target_user_id, status, batch_id: batch_id ?? null })
const ME = 'me'

describe('classifyIntroHistory — tiered permanent-history exclusion', () => {
  it('HARD (permanent, valve never releases): pending/accepted/admin_pending/approved/declined/rejected/hidden/hidden_permanent', () => {
    for (const s of Array.from(HARD_HISTORY_STATUSES)) {
      const { hardExcluded, softExcluded } = classifyIntroHistory(ME, [row(ME, 'x', s)])
      expect(hardExcluded.has('x')).toBe(true)
      expect(softExcluded.has('x')).toBe(false)
    }
  })

  it('accepted_pending_payment is HARD — a mid-payment pair is never recommended again', () => {
    const { hardExcluded, softExcluded } = classifyIntroHistory(ME, [row(ME, 'x', 'accepted_pending_payment')])
    expect(hardExcluded.has('x')).toBe(true)
    expect(softExcluded.has('x')).toBe(false)
    // bidirectional: inbound row excludes too
    expect(classifyIntroHistory(ME, [row('other', ME, 'accepted_pending_payment')]).hardExcluded.has('other')).toBe(true)
  })

  it('accepted/approved/pending/declined/rejected/hidden are HARD (regardless of the safety valve)', () => {
    const rows = ['accepted', 'approved', 'pending', 'declined', 'rejected', 'hidden', 'hidden_permanent']
      .map((s, i) => row(ME, `t${i}`, s))
    const { hardExcluded, softExcluded } = classifyIntroHistory(ME, rows)
    expect(hardExcluded.size).toBe(7)
    expect(softExcluded.size).toBe(0)
  })

  it('active window (suggested/queued) is HARD — never a duplicate', () => {
    const { hardExcluded } = classifyIntroHistory(ME, [row(ME, 's', 'suggested', 'b1'), row(ME, 'q', 'queued', 'b2')])
    expect(hardExcluded.has('s')).toBe(true)
    expect(hardExcluded.has('q')).toBe(true)
  })

  it('SOFT (releasable): passed, expired, and archived from a REAL displayed batch', () => {
    const { hardExcluded, softExcluded } = classifyIntroHistory(ME, [
      row(ME, 'p', 'passed'),
      row(ME, 'e', 'expired'),
      row(ME, 'a', 'archived', 'batch-123'), // shown then completed → soft
    ])
    expect(softExcluded.has('p')).toBe(true)
    expect(softExcluded.has('e')).toBe(true)
    expect(softExcluded.has('a')).toBe(true)
    expect(hardExcluded.size).toBe(0)
  })

  it('ARTIFACT: archived with NO batch_id (migration/backfill) is NOT history → eligible', () => {
    const { hardExcluded, softExcluded } = classifyIntroHistory(ME, [row(ME, 'artifact', 'archived', null)])
    expect(hardExcluded.has('artifact')).toBe(false)
    expect(softExcluded.has('artifact')).toBe(false) // neither tier → eligible
  })

  it('separates shown archived (soft) from artifact archived (eligible)', () => {
    const { softExcluded } = classifyIntroHistory(ME, [
      row(ME, 'shown', 'archived', 'batch-9'),
      row(ME, 'artifact', 'archived', null),
    ])
    expect(softExcluded.has('shown')).toBe(true)
    expect(softExcluded.has('artifact')).toBe(false)
  })

  it('HARD dominates SOFT when a pair has rows in both tiers', () => {
    const { hardExcluded, softExcluded } = classifyIntroHistory(ME, [
      row(ME, 'x', 'passed'), // soft
      row(ME, 'x', 'approved'), // hard — wins
    ])
    expect(hardExcluded.has('x')).toBe(true)
    expect(softExcluded.has('x')).toBe(false)
  })

  it('exclusion is BIDIRECTIONAL (row where ME is the target)', () => {
    const hard = classifyIntroHistory(ME, [row('other', ME, 'declined')]).hardExcluded
    const soft = classifyIntroHistory(ME, [row('other', ME, 'passed')]).softExcluded
    expect(hard.has('other')).toBe(true)
    expect(soft.has('other')).toBe(true)
  })

  it('never excludes self; empty/null input yields empty sets', () => {
    expect(classifyIntroHistory(ME, [row(ME, ME, 'approved')]).hardExcluded.has(ME)).toBe(false)
    expect(classifyIntroHistory(ME, []).hardExcluded.size).toBe(0)
    expect(classifyIntroHistory(ME, null).softExcluded.size).toBe(0)
  })

  it('unknown/legacy status invents no exclusion', () => {
    const { hardExcluded, softExcluded } = classifyIntroHistory(ME, [row(ME, 'x', 'weird_legacy')])
    expect(hardExcluded.size).toBe(0)
    expect(softExcluded.size).toBe(0)
  })
})

describe('exhaustionThreshold — configurable safety valve', () => {
  const prev = process.env.RECOMMENDATION_EXHAUSTION_THRESHOLD
  afterEach(() => { if (prev === undefined) delete process.env.RECOMMENDATION_EXHAUSTION_THRESHOLD; else process.env.RECOMMENDATION_EXHAUSTION_THRESHOLD = prev })

  it('defaults to 0 (disabled) when unset or non-positive', () => {
    delete process.env.RECOMMENDATION_EXHAUSTION_THRESHOLD
    expect(exhaustionThreshold()).toBe(0)
    process.env.RECOMMENDATION_EXHAUSTION_THRESHOLD = '0'
    expect(exhaustionThreshold()).toBe(0)
    process.env.RECOMMENDATION_EXHAUSTION_THRESHOLD = '-3'
    expect(exhaustionThreshold()).toBe(0)
  })
  it('reads a positive integer threshold', () => {
    process.env.RECOMMENDATION_EXHAUSTION_THRESHOLD = '5'
    expect(exhaustionThreshold()).toBe(5)
    process.env.RECOMMENDATION_EXHAUSTION_THRESHOLD = '12'
    expect(exhaustionThreshold()).toBe(12)
  })
})

describe('isIntroHistoryRow', () => {
  it('treats HARD, ACTIVE, and SOFT statuses as history', () => {
    for (const s of ['accepted', 'pending', 'approved', 'declined', 'rejected', 'hidden', 'hidden_permanent', 'suggested', 'queued', 'passed', 'expired']) {
      expect(isIntroHistoryRow(s, 'b1')).toBe(true)
      expect(isIntroHistoryRow(s, null)).toBe(true) // batch_id irrelevant for these
    }
  })
  it('archived is history ONLY with a batch_id (artifact carve-out)', () => {
    expect(isIntroHistoryRow('archived', 'b1')).toBe(true)
    expect(isIntroHistoryRow('archived', null)).toBe(false)
  })
  it('unknown/empty status is never history', () => {
    expect(isIntroHistoryRow('weird', 'b1')).toBe(false)
    expect(isIntroHistoryRow(null, 'b1')).toBe(false)
    expect(isIntroHistoryRow('', 'b1')).toBe(false)
  })
})

describe('buildIntroHistoryExclusions — bidirectional pair map', () => {
  it('adds both directions for a genuine-history row', () => {
    const m = buildIntroHistoryExclusions([row('a', 'b', 'suggested')])
    expect(m.get('a')?.has('b')).toBe(true)
    expect(m.get('b')?.has('a')).toBe(true)
  })
  it('excludes migration artifacts (archived, no batch_id) and unknown statuses', () => {
    const m = buildIntroHistoryExclusions([row('a', 'b', 'archived', null), row('c', 'd', 'weird')])
    expect(m.get('a')?.has('b') ?? false).toBe(false)
    expect(m.get('c')?.has('d') ?? false).toBe(false)
  })
  it('includes archived WITH a batch_id (genuinely presented)', () => {
    const m = buildIntroHistoryExclusions([row('a', 'b', 'archived', 'b1')])
    expect(m.get('a')?.has('b')).toBe(true)
  })
  it('ignores self-pairs and empty input', () => {
    expect(buildIntroHistoryExclusions([row('a', 'a', 'accepted')]).size).toBe(0)
    expect(buildIntroHistoryExclusions(null).size).toBe(0)
    expect(buildIntroHistoryExclusions([]).size).toBe(0)
  })
  it('accumulates multiple targets per member', () => {
    const m = buildIntroHistoryExclusions([row('a', 'b', 'passed'), row('a', 'c', 'accepted')])
    expect(m.get('a')?.has('b')).toBe(true)
    expect(m.get('a')?.has('c')).toBe(true)
  })
})
