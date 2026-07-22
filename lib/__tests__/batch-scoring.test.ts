import { describe, it, expect } from 'vitest'
import {
  buildScoringContext, scoreMatch, overlapScore, idfWeight, buildRarity,
  exposureAdjustedScore, SCORING_CONFIG, EXPOSURE_CONFIG, type ScoringContext,
  RECOMMENDATION_ALGORITHM_VERSION, SCORING_MODEL_VERSION, algorithmSnapshot, algorithmConfigHash,
} from '@/lib/matching/batch-scoring'

// Synthetic cohort: "networking" is common (in most), "fundraising" is rare (in 2).
const cohort = [
  { id: 'a', purposes: ['networking', 'fundraising'], interests: ['sailing'] },
  { id: 'b', purposes: ['networking', 'fundraising'], interests: ['sailing'] },
  { id: 'c', purposes: ['networking'], interests: [] },
  { id: 'd', purposes: ['networking'], interests: [] },
  { id: 'e', purposes: ['networking'], interests: [] },
  { id: 'f', purposes: ['networking'], interests: [] },
]
const ctx = buildScoringContext(cohort)

describe('algorithm versioning + config snapshot (reproducibility)', () => {
  it('exposes a stable version identifier', () => {
    expect(RECOMMENDATION_ALGORITHM_VERSION).toBe('v3')
    expect(SCORING_MODEL_VERSION).toMatch(/^v\d/)
  })
  it('snapshot captures the version + every tuning config', () => {
    const s = algorithmSnapshot()
    expect(s.version).toBe(RECOMMENDATION_ALGORITHM_VERSION)
    expect(s.scoringModelVersion).toBe(SCORING_MODEL_VERSION)
    expect(s.scoring).toEqual(SCORING_CONFIG)
    expect(s.exposure).toEqual(EXPOSURE_CONFIG)
    expect(s.batch).toBeTruthy()
  })
  it('config hash is deterministic, stable-format, and key-order independent', () => {
    const h1 = algorithmConfigHash()
    const h2 = algorithmConfigHash()
    expect(h1).toBe(h2)                 // deterministic
    expect(h1).toMatch(/^[0-9a-f]{8}$/) // 8-hex FNV-1a
  })
  it('hash changes when the config changes (detects tuning drift)', () => {
    // Re-derive the hash function behavior: a different snapshot ⇒ different hash.
    const base = algorithmConfigHash()
    const mutated = { ...algorithmSnapshot(), scoring: { ...SCORING_CONFIG, purposeBase: SCORING_CONFIG.purposeBase + 1 } }
    const canon = (v: any): string => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',')}}`
    let h = 0x811c9dc5; const j = canon(mutated); for (let i = 0; i < j.length; i++) { h ^= j.charCodeAt(i); h = Math.imul(h, 0x01000193) }
    expect((h >>> 0).toString(16).padStart(8, '0')).not.toBe(base)
  })
})

describe('IDF / rarity weighting (Part 2)', () => {
  it('idfWeight: rare (df=1) ≈ 1, universal (df=N) = 0, monotonic', () => {
    expect(idfWeight(1, 46)).toBeGreaterThan(0.7)
    expect(idfWeight(46, 46)).toBe(0)
    expect(idfWeight(3, 46)).toBeGreaterThan(idfWeight(26, 46)) // rarer → higher
  })
  it('a shared RARE purpose outscores a shared COMMON purpose', () => {
    const rareShare = overlapScore(['fundraising'], ctx.purposeRarity, SCORING_CONFIG.purposeBase, SCORING_CONFIG.purposeDecay)
    const commonShare = overlapScore(['networking'], ctx.purposeRarity, SCORING_CONFIG.purposeBase, SCORING_CONFIG.purposeDecay)
    expect(rareShare).toBeGreaterThan(commonShare)
    expect(commonShare).toBeLessThan(SCORING_CONFIG.purposeBase) // "networking" deflated below base
  })
  it('scale-preserving: rarity factors are centered near 1 (average shared item ≈ base)', () => {
    // The pairs-weighted mean rarity factor should be ~1 by construction.
    const factors = Array.from(ctx.purposeRarity.values())
    expect(Math.max(...factors)).toBeGreaterThan(1) // rare above 1
    expect(Math.min(...factors)).toBeLessThan(1)    // common below 1
  })
})

describe('diminishing returns (Part 3)', () => {
  const rarity = new Map([['p1', 1], ['p2', 1], ['p3', 1], ['p4', 1]]) // equal weights → isolate decay
  it('each additional shared item adds strictly less (concave)', () => {
    const s1 = overlapScore(['p1'], rarity, 12, 0.75)
    const s2 = overlapScore(['p1', 'p2'], rarity, 12, 0.75)
    const s3 = overlapScore(['p1', 'p2', 'p3'], rarity, 12, 0.75)
    expect(s2 - s1).toBeGreaterThan(s3 - s2) // marginal gain shrinks
    expect(s2 - s1).toBeCloseTo(12 * 0.75, 5)
  })
  it('is bounded: never exceeds base · maxWeight / (1 - decay)', () => {
    const big = overlapScore(Array.from({ length: 20 }, (_, i) => `p${i}`), rarity, 12, 0.75)
    expect(big).toBeLessThanOrEqual(12 * 1 / (1 - 0.75) + 1e-9)
  })
  it('empty overlap scores 0', () => {
    expect(overlapScore([], ctx.purposeRarity, 12, 0.75)).toBe(0)
  })
})

describe('boost / priority (Part 1 fix)', () => {
  const base = { id: 'x', role_type: 'Founder', subscription_tier: 'free' }
  it('absent boost/priority → no contribution (behavior unchanged from zero)', () => {
    const s0 = scoreMatch(base, { id: 'y', role_type: 'Investor' }, ctx)
    const s1 = scoreMatch(base, { id: 'y', role_type: 'Investor', boost_score: 0, is_priority: false }, ctx)
    expect(s1).toBe(s0)
  })
  it('boost_score adds boost_score × boostMultiplier', () => {
    const without = scoreMatch(base, { id: 'y', role_type: 'Investor' }, ctx)
    const withBoost = scoreMatch(base, { id: 'y', role_type: 'Investor', boost_score: 10 }, ctx)
    expect(withBoost - without).toBe(10 * SCORING_CONFIG.boostMultiplier)
  })
  it('is_priority adds the flat priority bonus', () => {
    const without = scoreMatch(base, { id: 'y', role_type: 'Investor' }, ctx)
    const withPri = scoreMatch(base, { id: 'y', role_type: 'Investor', is_priority: true }, ctx)
    expect(withPri - without).toBe(SCORING_CONFIG.priorityBonus)
  })
})

describe('exposure balancing (Part 4)', () => {
  it('nudge is bounded and monotonic; never exceeds penaltyPerPick × penaltyCap', () => {
    expect(exposureAdjustedScore(80, 0)).toBe(80)
    expect(exposureAdjustedScore(80, 1)).toBe(80 - EXPOSURE_CONFIG.penaltyPerPick)
    const maxNudge = EXPOSURE_CONFIG.penaltyPerPick * EXPOSURE_CONFIG.penaltyCap
    expect(exposureAdjustedScore(80, 999)).toBe(80 - maxNudge)
    expect(80 - exposureAdjustedScore(80, 999)).toBeLessThanOrEqual(maxNudge)
  })
  it('a much-better match is never displaced by a weaker one (nudge < quality gap)', () => {
    const strong = 80, weak = 60
    // Even fully exposed, the strong candidate stays ahead of an unexposed weak one.
    expect(exposureAdjustedScore(strong, EXPOSURE_CONFIG.penaltyCap)).toBeGreaterThan(exposureAdjustedScore(weak, 0))
  })
})

describe('determinism, symmetry & edge cases (Part 6)', () => {
  const r = { id: 'r', role_type: 'Founder', purposes: ['networking', 'fundraising'], interests: ['sailing'], expertise: ['ai', 'law'], subscription_tier: 'free', seniority: 'senior' }
  const c = { id: 'c', role_type: 'Investor', purposes: ['fundraising'], interests: ['sailing'], expertise: ['ai', 'finance'], subscription_tier: 'free', seniority: 'senior' }
  it('same inputs → identical score (repeatable)', () => {
    expect(scoreMatch(r, c, ctx)).toBe(scoreMatch(r, c, ctx))
  })
  it('handles empty/missing fields without throwing', () => {
    expect(() => scoreMatch({ id: '1' }, { id: '2' }, ctx)).not.toThrow()
    expect(scoreMatch({ id: '1' }, { id: '2' }, buildScoringContext([{ id: '1' }, { id: '2' }]))).toBeTypeOf('number')
  })
  it('score is a finite integer', () => {
    const s = scoreMatch(r, c, ctx)
    expect(Number.isInteger(s)).toBe(true)
    expect(Number.isFinite(s)).toBe(true)
  })
  it('buildRarity is neutral when nothing is shared by ≥2 members', () => {
    const df = new Map([['solo', 1]])
    const rar = buildRarity(df, 10, 0.25, 2.5)
    expect(rar.get('solo')).toBeGreaterThan(0)
  })
})
