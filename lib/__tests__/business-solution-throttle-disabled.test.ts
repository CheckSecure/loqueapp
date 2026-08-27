import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { maxBusinessSolutionCount } from '@/lib/matching/business-solutions'

const SRC = readFileSync('lib/matching/business-solutions.ts', 'utf8')
const TIERS = ['free', 'professional', 'executive', 'founding'] as const

describe('business-solution throttle is disabled by default', () => {
  // ── The defect. At the launch-phase capacity of 2 the percentage collapses to zero for
  // every tier, which made the quota a hard block rather than a limit.
  it('the raw percentage really does yield 0 at capacity 2 (why this was disabled)', () => {
    const BASE = 0.30, PREF = 0.5
    const MULT: Record<string, number> = { free: 1.0, professional: 0.7, executive: 0.5, founding: 0.7 }
    for (const tier of TIERS) {
      const raw = Math.floor(2 * BASE * MULT[tier])
      expect(raw, tier).toBe(0)                          // the accident
      expect(Math.floor(raw * PREF), tier).toBe(0)       // not opted in → zero providers allowed
    }
  })

  // ── The fix: never below the member's own capacity, so it cannot bind.
  it('quota is never below targetCount, for any tier or opt-in state', () => {
    for (const tier of TIERS)
      for (const opted of [true, false])
        for (const target of [1, 2, 3, 5, 8])
          expect(maxBusinessSolutionCount(opted, tier, target), `${tier}/${opted}/${target}`)
            .toBeGreaterThanOrEqual(target)
  })

  it('at capacity 2 nobody is blocked — this is the production case', () => {
    for (const tier of TIERS)
      expect(maxBusinessSolutionCount(false, tier, 2), tier).toBeGreaterThanOrEqual(2)
  })

  it('an unknown tier still cannot produce a binding quota', () => {
    expect(maxBusinessSolutionCount(false, 'nonexistent-tier', 2)).toBeGreaterThanOrEqual(2)
  })

  // ── Reversibility is the point: the original computation must still be in the file,
  // reachable by one environment variable, not deleted.
  it('the original computation is preserved behind an env flag', () => {
    expect(SRC).toMatch(/BUSINESS_SOLUTION_THROTTLE_ENABLED/)
    expect(SRC).toMatch(/process\.env\.BUSINESS_SOLUTION_THROTTLE/)
    expect(SRC).toMatch(/if \(BUSINESS_SOLUTION_THROTTLE_ENABLED\) return computed/)
    expect(SRC).toMatch(/openToSolutions \? Math\.max\(1, raw\) : Math\.floor\(raw \* PREFERENCE_ADJUSTMENT\)/)
  })

  it('the code records why it was disabled and how to reinstate it', () => {
    expect(SRC).toMatch(/MEASURED on production/)
    expect(SRC).toMatch(/REINSTATING IT PROPERLY/)
    expect(SRC).toMatch(/112 of 116/)
  })

  // ── Scope guard: this change must not have touched the score floor.
  it('MIN_RELEVANCE_SCORE was not altered by this change', () => {
    expect(readFileSync('lib/matching/batch-scoring.ts', 'utf8'))
      .toMatch(/minRelevanceScore: 40/)
  })
})
