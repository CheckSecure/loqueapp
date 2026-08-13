import { describe, it, expect, beforeEach } from 'vitest'
import {
  coverageEnabled, coverageEventForOutcome, selectCoverageMembers, COVERAGE_MEMBER_LIMIT,
} from '@/lib/introductions/coverageGeneration'

describe('coverageEnabled — default ON, kill-switch only', () => {
  beforeEach(() => { delete process.env.WEEKLY_COVERAGE_GENERATION })
  it('unset → enabled', () => expect(coverageEnabled()).toBe(true))
  it("'off' (any case/space) → disabled", () => {
    for (const v of ['off', 'OFF', ' Off ']) { process.env.WEEKLY_COVERAGE_GENERATION = v; expect(coverageEnabled()).toBe(false) }
  })
  it("any other value → enabled", () => {
    for (const v of ['on', '1', '', 'true']) { process.env.WEEKLY_COVERAGE_GENERATION = v; expect(coverageEnabled()).toBe(true) }
  })
})

describe('coverageEventForOutcome — coarse, honest buckets', () => {
  it('maps every generator outcome without a weak fallback', () => {
    expect(coverageEventForOutcome('created')).toBe('covered')
    expect(coverageEventForOutcome('empty_pool')).toBe('no_candidate')
    expect(coverageEventForOutcome('no_compatible_candidate')).toBe('no_candidate')
    expect(coverageEventForOutcome('noop_at_capacity')).toBe('at_capacity')
    expect(coverageEventForOutcome('capacity')).toBe('at_capacity')
    expect(coverageEventForOutcome('ineligible')).toBe('ineligible')
    expect(coverageEventForOutcome('transient_error')).toBe('transient')
  })
})

describe('selectCoverageMembers — zero-card only, bounded, order-preserving', () => {
  it('returns only members without an active card', () => {
    const eligible = ['a', 'b', 'c', 'd']
    expect(selectCoverageMembers(eligible, new Set(['b', 'd']))).toEqual(['a', 'c'])
  })
  it('caps at the member limit and preserves the caller-supplied order', () => {
    const eligible = Array.from({ length: COVERAGE_MEMBER_LIMIT + 10 }, (_, i) => `m${i}`)
    const out = selectCoverageMembers(eligible, new Set())
    expect(out).toHaveLength(COVERAGE_MEMBER_LIMIT)
    expect(out[0]).toBe('m0'); expect(out[COVERAGE_MEMBER_LIMIT - 1]).toBe(`m${COVERAGE_MEMBER_LIMIT - 1}`)
  })
  it('a custom (smaller) limit is honored', () => {
    expect(selectCoverageMembers(['a', 'b', 'c'], new Set(), 2)).toEqual(['a', 'b'])
  })
  it('all carded → empty', () => {
    expect(selectCoverageMembers(['a', 'b'], new Set(['a', 'b']))).toEqual([])
  })
})
