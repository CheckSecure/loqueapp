import { describe, it, expect } from 'vitest'
import { parseExpertise } from '@/lib/parseExpertise'

// Regression coverage for the two expertise-format fixes:
//   - lib/generate-recommendations.ts  candidate eligibility gate
//   - lib/trust/signals.ts             profile_complete trust signal
// Both now derive presence from parseExpertise(...).length > 0 (the single
// canonical parser), so string-stored expertise is measured by real item count.

describe('parseExpertise — canonical parser across storage formats', () => {
  it('JSON-string array (the production format)', () => {
    expect(parseExpertise('["Legal","M&A","Cybersecurity"]')).toEqual(['Legal', 'M&A', 'Cybersecurity'])
  })
  it('native string array', () => {
    expect(parseExpertise(['Legal', 'M&A'])).toEqual(['Legal', 'M&A'])
  })
  it('empty JSON string "[]" → empty', () => {
    expect(parseExpertise('[]')).toEqual([])
  })
  it('empty native array → empty', () => {
    expect(parseExpertise([])).toEqual([])
  })
  it('null / undefined / blank / "{}" → empty', () => {
    for (const v of [null, undefined, '', '   ', '{}']) expect(parseExpertise(v)).toEqual([])
  })
  it('malformed string never throws and always yields an array', () => {
    for (const v of ['["Legal"', '[,,]', 'not-json', '{oops']) {
      expect(Array.isArray(parseExpertise(v))).toBe(true)
    }
  })
})

// Mirrors the exact predicate now used at the candidate eligibility gate:
//   return parseExpertise(u.expertise).length > 0
const candidateHasExpertise = (u: { expertise: unknown }) => parseExpertise(u.expertise).length > 0

describe('candidate eligibility gate (generate-recommendations)', () => {
  it('JSON-string expertise → eligible (was the bug: string bypassed the check)', () => {
    expect(candidateHasExpertise({ expertise: '["Legal","M&A"]' })).toBe(true)
  })
  it('native array with values → eligible', () => {
    expect(candidateHasExpertise({ expertise: ['Legal'] })).toBe(true)
  })
  it('empty JSON string "[]" → NOT eligible (previously slipped through as true)', () => {
    expect(candidateHasExpertise({ expertise: '[]' })).toBe(false)
  })
  it('empty array → NOT eligible', () => {
    expect(candidateHasExpertise({ expertise: [] })).toBe(false)
  })
  it('null → NOT eligible', () => {
    expect(candidateHasExpertise({ expertise: null })).toBe(false)
  })
})

// Mirrors the exact predicate now used in the profile_complete trust signal:
//   parseExpertise(profile.expertise).length > 0
const profileExpertisePresent = (p: { expertise: unknown }) => parseExpertise(p.expertise).length > 0

describe('profile_complete trust signal (trust/signals)', () => {
  it('JSON-string expertise counts as present', () => {
    expect(profileExpertisePresent({ expertise: '["Legal"]' })).toBe(true)
  })
  it('empty JSON string "[]" counts as ABSENT (was a false-positive: string length 2 > 0)', () => {
    expect(profileExpertisePresent({ expertise: '[]' })).toBe(false)
  })
  it('native array present vs empty', () => {
    expect(profileExpertisePresent({ expertise: ['Legal', 'M&A'] })).toBe(true)
    expect(profileExpertisePresent({ expertise: [] })).toBe(false)
  })
})
