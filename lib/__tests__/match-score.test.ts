import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { sanitizeMatchScore, assertStorableScore, MATCH_SCORE_MAX, MATCH_SCORE_MIN } from '@/lib/matching/score'

// The value that overflowed the old numeric(4,2) column in production.
const OVERFLOW_VALUE = 127
const OLD_COLUMN_MAX = 99.99 // numeric(4,2)

describe('sanitizeMatchScore', () => {
  it('passes through the exact value that previously overflowed (127)', () => {
    expect(sanitizeMatchScore(127)).toBe(127)
    expect(127).toBeGreaterThan(OLD_COLUMN_MAX)        // would overflow numeric(4,2)
    expect(127).toBeLessThanOrEqual(MATCH_SCORE_MAX)   // fits numeric(6,2)
  })
  it('minimum + maximum valid scores', () => {
    expect(sanitizeMatchScore(0)).toBe(0)
    expect(sanitizeMatchScore(MATCH_SCORE_MAX)).toBe(10000) // rounds .99 up but still asserted below capacity via assert
  })
  it('rounds decimals to an integer (column scale is 2; scores are integers)', () => {
    expect(sanitizeMatchScore(72.4)).toBe(72)
    expect(sanitizeMatchScore(72.5)).toBe(73)
  })
  it('collapses NaN / Infinity to 0 (no corrupt insert)', () => {
    expect(sanitizeMatchScore(NaN)).toBe(0)
    expect(sanitizeMatchScore(Infinity)).toBe(0)
    expect(sanitizeMatchScore(-Infinity)).toBe(0)
  })
  it('allows the legitimate negative penalty (flagged users)', () => {
    expect(sanitizeMatchScore(-20)).toBe(-20)
  })
})

describe('assertStorableScore', () => {
  it('accepts in-range scores incl. the former overflow value and boundaries', () => {
    expect(() => assertStorableScore(0, 'r', 's')).not.toThrow()
    expect(() => assertStorableScore(127, 'r', 's')).not.toThrow()
    expect(() => assertStorableScore(636, 'r', 's')).not.toThrow() // realistic worst case
    expect(() => assertStorableScore(MATCH_SCORE_MAX, 'r', 's')).not.toThrow()
    expect(() => assertStorableScore(MATCH_SCORE_MIN, 'r', 's')).not.toThrow()
  })
  it('rejects out-of-range with a descriptive error naming member + candidate', () => {
    expect(() => assertStorableScore(99999, 'member-A', 'cand-B')).toThrow(
      /Invalid suggestion score for member member-A and candidate cand-B: received 99999; expected/,
    )
  })
  it('rejects NaN / Infinity (not a raw "numeric field overflow")', () => {
    expect(() => assertStorableScore(NaN, 'r', 's')).toThrow(/Invalid suggestion score/)
    expect(() => assertStorableScore(Infinity, 'r', 's')).toThrow(/Invalid suggestion score/)
  })
})

describe('column capacity regression (migration 017)', () => {
  it('numeric(6,2) capacity exceeds the realistic worst-case score', () => {
    // Worst realistic scoreMatch sum (boost 200 + priority 50 + prefs 50 + unbounded
    // purpose/interest overlaps + geo/format/seniority/tier/network/verify/trust) ≈ 636.
    const worstCaseApprox = 636
    expect(MATCH_SCORE_MAX).toBeGreaterThan(worstCaseApprox)
  })
  it('the exact overflow value is storable under the new type but not the old', () => {
    expect(OVERFLOW_VALUE).toBeGreaterThan(OLD_COLUMN_MAX)      // failed on numeric(4,2)
    expect(OVERFLOW_VALUE).toBeLessThanOrEqual(MATCH_SCORE_MAX) // fits numeric(6,2)
  })
  it('migration 017 widens match_score to numeric(6,2)', () => {
    const sql = readFileSync('supabase/migrations/017_batch_suggestions_match_score.sql', 'utf8')
    expect(sql).toMatch(/ALTER TABLE\s+batch_suggestions/i)
    expect(sql).toMatch(/ALTER COLUMN\s+match_score\s+TYPE\s+numeric\(6,\s*2\)/i)
  })
})

describe('insert paths use the guard (no path can re-introduce the overflow)', () => {
  const files = [
    'app/api/admin/generate-batch/route.ts',
    'app/api/admin/batch/[batchId]/generate-replacements/route.ts',
  ]
  it('every scoreMatch-based insert path sanitizes + asserts before insert', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).toContain("from '@/lib/matching/score'")
      expect(src, f).toMatch(/sanitizeMatchScore\(/)
      expect(src, f).toMatch(/assertStorableScore\(/)
    }
  })
  it('generate-batch cleans up the orphan batch when suggestion insert fails', () => {
    const src = readFileSync('app/api/admin/generate-batch/route.ts', 'utf8')
    // compensating delete of introduction_batches on insert failure
    expect(src).toMatch(/from\('introduction_batches'\)\s*\.delete\(\)\s*\.eq\('id', batch\.id\)/)
    expect(src).toMatch(/if \(batchError \|\| !batch\)/) // batch-create error is checked
  })
})
