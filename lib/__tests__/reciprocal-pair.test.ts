import { describe, it, expect } from 'vitest'
import {
  canonicalPair, canonicalPairKey, isSelfPair,
  selectFairCounterpart, selectFairCounterparts, EXPOSURE_PENALTY_CAP, type Counterpart,
} from '@/lib/matching/reciprocalPair'
import { readScoringSignals } from '@/lib/matching/profileScoring'

describe('canonical pair — reversed duplicates & self-pairs impossible', () => {
  it('(A,B) and (B,A) resolve to the SAME canonical key and tuple', () => {
    expect(canonicalPairKey('b', 'a')).toBe(canonicalPairKey('a', 'b'))
    expect(canonicalPair('b', 'a')).toEqual(['a', 'b'])
  })
  it('rejects self-pairs', () => {
    expect(isSelfPair('a', 'a')).toBe(true)
    expect(() => canonicalPair('a', 'a')).toThrow()
  })
})

describe('selectFairCounterpart — BOUNDED exposure (fit still wins)', () => {
  it('no candidates → null (honest empty state, never a forced match)', () => {
    expect(selectFairCounterpart([])).toBeNull()
  })
  it('a materially-better candidate wins DESPITE higher exposure (poor-fit low-exposure never wins)', () => {
    const c: Counterpart[] = [
      { id: 'strong', inbound: 5, score: 90 }, // eff 90 - min(6,10) = 84
      { id: 'weak', inbound: 0, score: 40 },   // eff 40
    ]
    expect(selectFairCounterpart(c)!.id).toBe('strong')
    // the gap (50) exceeds the cap (6), so load can never flip it
    expect(90 - 40).toBeGreaterThan(EXPOSURE_PENALTY_CAP)
  })
  it('among NEAR-EQUAL candidates, lower exposure wins (spreads load)', () => {
    const c: Counterpart[] = [
      { id: 'a', inbound: 3, score: 80 }, // eff 80 - 6 = 74
      { id: 'b', inbound: 0, score: 78 }, // eff 78
    ]
    expect(selectFairCounterpart(c)!.id).toBe('b')
  })
  it('exact ties break by lower load then deterministic id', () => {
    expect(selectFairCounterpart([{ id: 'z', inbound: 0, score: 50 }, { id: 'a', inbound: 0, score: 50 }])!.id).toBe('a')
    expect(selectFairCounterpart([{ id: 'z', inbound: 1, score: 50 }, { id: 'a', inbound: 3, score: 50 }])!.id).toBe('z')
  })
})

describe('selectFairCounterparts — distinct top-N', () => {
  it('picks distinct counterparts and never repeats', () => {
    const picks = selectFairCounterparts([
      { id: 'a', inbound: 0, score: 90 }, { id: 'b', inbound: 0, score: 88 }, { id: 'c', inbound: 0, score: 86 },
    ], 2)
    expect(picks.map(p => p.id)).toEqual(['a', 'b'])
    expect(new Set(picks.map(p => p.id)).size).toBe(2)
  })
  it('empty pool → [] (honest empty)', () => {
    expect(selectFairCounterparts([], 5)).toEqual([])
  })
})

describe('REGRESSION: identical fresh accounts DISTRIBUTE across good-fit members (not all → one)', () => {
  it('near-equal good-fit candidates spread as live exposure rises; score-only would pick one', () => {
    // Three equally good-fit candidates (the corrected scoring differentiates real fit; here they
    // are genuinely near-equal). Assign 6 sequential fresh members; each assignment raises the
    // chosen counterpart's live inbound exposure, so the next member prefers a less-exposed peer.
    const exposure: Record<string, number> = { hernan: 0, bianca: 0, carlos: 0 }
    const baseScore: Record<string, number> = { hernan: 90, bianca: 90, carlos: 90 }
    const assigned: string[] = []
    for (let i = 0; i < 6; i++) {
      const cands: Counterpart[] = Object.keys(baseScore).map(id => ({ id, score: baseScore[id], inbound: exposure[id] }))
      const pick = selectFairCounterpart(cands)!
      assigned.push(pick.id)
      exposure[pick.id] += 1 // reciprocal pair created → counterpart's inbound rises
    }
    // OLD score-only behaviour would return the same top every time; the fair model spreads 2/2/2.
    expect(new Set(assigned).size).toBe(3)
    expect(assigned.filter(x => x === 'hernan').length).toBe(2)
    expect(assigned.filter(x => x === 'bianca').length).toBe(2)
    expect(assigned.filter(x => x === 'carlos').length).toBe(2)
  })
})

describe('typed DB-boundary scoring mapper (field-name bug fix)', () => {
  it('reads the REAL snake_case columns; falls back to neutral 50 only when absent', () => {
    expect(readScoringSignals({ network_value_score: 80, responsiveness_score: 70 })).toEqual({ networkValueScore: 80, responsivenessScore: 70 })
    expect(readScoringSignals({ network_value_score: null })).toEqual({ networkValueScore: 50, responsivenessScore: 50 })
    expect(readScoringSignals(undefined)).toEqual({ networkValueScore: 50, responsivenessScore: 50 })
    // the OLD camelCase read would have been undefined → 50 for everyone:
    expect(readScoringSignals({ network_value_score: 92 } as any).networkValueScore).toBe(92)
  })
})
