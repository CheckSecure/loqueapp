import { describe, it, expect } from 'vitest'
import { summarizePoolHealth, type MemberPool } from '@/lib/introductions/poolHealth'

const m = (memberId: string, pool: number, hard = 0, soft = 0, artifacts = 0, valveActive = false): MemberPool =>
  ({ memberId, name: memberId, pool, hard, soft, artifacts, valveActive })

describe('summarizePoolHealth — pool-health monitoring', () => {
  it('aggregates pools, exclusions, and threshold buckets', () => {
    const members = [m('a', 50, 4, 2, 3), m('b', 18, 30, 5, 1), m('c', 12, 40, 3, 0), m('d', 4, 48, 1, 0)]
    const r = summarizePoolHealth(members, 0)
    expect(r.networkSize).toBe(4)
    expect(r.pool).toEqual({ avg: 21, min: 4, max: 50 })
    expect(r.exclusions.avgHard).toBe(30.5)
    expect(r.exclusions.avgSoft).toBe(2.8)
    expect(r.exclusions.avgArtifactsIgnored).toBe(1)
    // buckets are strict "<": pools 50,18,12,4
    expect(r.membersBelowThreshold[20]).toBe(3) // 18,12,4
    expect(r.membersBelowThreshold[15]).toBe(2) // 12,4
    expect(r.membersBelowThreshold[10]).toBe(1) // 4
    expect(r.membersBelowThreshold[5]).toBe(1)  // 4
  })

  it('reports the valve disabled at threshold 0 and no activations', () => {
    const r = summarizePoolHealth([m('a', 3), m('b', 40)], 0)
    expect(r.valve).toEqual({ enabled: false, threshold: 0, activatedMembers: 0 })
  })

  it('reports valve enabled + counts activated members when a threshold is set', () => {
    const members = [m('a', 3, 0, 0, 0, true), m('b', 8, 0, 0, 0, true), m('c', 40, 0, 0, 0, false)]
    const r = summarizePoolHealth(members, 10)
    expect(r.valve).toEqual({ enabled: true, threshold: 10, activatedMembers: 2 })
  })

  it('lists the smallest pools first (max 10)', () => {
    const members = Array.from({ length: 15 }, (_, i) => m(`u${i}`, 15 - i))
    const r = summarizePoolHealth(members, 0)
    expect(r.smallestPools).toHaveLength(10)
    expect(r.smallestPools[0].pool).toBe(1)
    expect(r.smallestPools[9].pool).toBe(10)
  })

  it('handles an empty network without throwing', () => {
    const r = summarizePoolHealth([], 0)
    expect(r.networkSize).toBe(0)
    expect(r.pool).toEqual({ avg: 0, min: 0, max: 0 })
  })
})
