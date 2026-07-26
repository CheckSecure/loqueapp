import { describe, it, expect, afterEach } from 'vitest'
import {
  classifyIntroHistory,
  exhaustionThreshold,
  HARD_HISTORY_STATUSES,
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
