import { describe, it, expect } from 'vitest'
import {
  applyExposureBalancing,
  exposurePenalty,
  DEFAULT_EXPOSURE_BALANCING,
} from '@/lib/matching/exposure-balancing'

const cand = (id: string, rankingScore: number) => ({ id, rankingScore })

describe('exposurePenalty — deterministic, floored, capped', () => {
  it('is zero at or below the fair-share floor', () => {
    expect(exposurePenalty(0)).toBe(0)
    expect(exposurePenalty(1)).toBe(0)
    expect(exposurePenalty(2)).toBe(0) // == softFloor
  })

  it('grows linearly above the floor', () => {
    expect(exposurePenalty(3)).toBe(1.5) // 1 over * 1.5
    expect(exposurePenalty(4)).toBe(3.0) // 2 over * 1.5
  })

  it('never exceeds the cap', () => {
    expect(exposurePenalty(6)).toBe(6) // 4 over * 1.5 = 6 (== cap)
    expect(exposurePenalty(20)).toBe(DEFAULT_EXPOSURE_BALANCING.maxPenalty)
  })
})

describe('applyExposureBalancing — rank-only re-sort', () => {
  it('ranks an over-exposed candidate below an equal-alignment zero-exposure candidate', () => {
    // Both start at the same ranking score; input order puts the popular one first.
    const candidates = [cand('popular', 50), cand('fresh', 50)]
    const exposure = new Map([['popular', 8]]) // fresh has 0
    const out = applyExposureBalancing(candidates, exposure)
    expect(out.map((c) => c.id)).toEqual(['fresh', 'popular'])
  })

  it('keeps a meaningfully higher-alignment candidate on top despite exposure (cap respected)', () => {
    // popular leads by 10 ranking points — larger than the max penalty (6),
    // so exposure balancing must NOT flip them.
    const candidates = [cand('popular', 60), cand('fresh', 50)]
    const exposure = new Map([['popular', 20]]) // penalty caps at 6 → 60-6=54 > 50
    const out = applyExposureBalancing(candidates, exposure)
    expect(out.map((c) => c.id)).toEqual(['popular', 'fresh'])
  })

  it('is a no-op when nobody is above the floor', () => {
    const candidates = [cand('a', 40), cand('b', 30)]
    const exposure = new Map([['a', 2], ['b', 1]]) // both <= floor
    const out = applyExposureBalancing(candidates, exposure)
    expect(out).toBe(candidates) // same reference — unchanged
  })

  it('preserves input order on tie in adjusted score (stable, deterministic)', () => {
    // a: 50, exposure 4 → penalty 3 → 47.  b: 47, exposure 0 → 47.  Tie → input order.
    const candidates = [cand('a', 50), cand('b', 47)]
    const exposure = new Map([['a', 4]])
    const out = applyExposureBalancing(candidates, exposure)
    expect(out.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('accepts a plain record as the exposure map', () => {
    const candidates = [cand('popular', 50), cand('fresh', 50)]
    const out = applyExposureBalancing(candidates, { popular: 9 })
    expect(out.map((c) => c.id)).toEqual(['fresh', 'popular'])
  })

  it('falls back to finalScore when rankingScore is absent', () => {
    const candidates = [
      { id: 'popular', finalScore: 50 },
      { id: 'fresh', finalScore: 50 },
    ]
    const out = applyExposureBalancing(candidates, { popular: 9 })
    expect(out.map((c) => c.id)).toEqual(['fresh', 'popular'])
  })
})
