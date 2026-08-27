import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  isSameSideLegalPair, isSameSideLegalPartnerEdge, lawFirmRole,
} from '@/lib/matching/legalSameSidePenalty'

/** Executable source only — comments legitimately name the thing the code must not do. */
const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ')
const GEN = code('app/api/admin/generate-batch/route.ts')

const P = (role: string | null) => ({ role_type: role })

describe('same-side legal is an absolute exclusion, not a tiebreak', () => {
  // ── The gap this rule closes. isSameSideLegalPartnerEdge needs a PARTNER on one side, so it
  // never fired on attorney↔attorney — which is precisely the pair reported in production.
  it('attorney↔attorney is same-side but is NOT a partner edge', () => {
    const a = P('Law firm attorney'), b = P('Law Firm Attorney')
    expect(lawFirmRole(a)).toBe('attorney')
    expect(lawFirmRole(b)).toBe('attorney')
    expect(isSameSideLegalPair(a, b)).toBe(true)
    expect(isSameSideLegalPartnerEdge(a, b)).toBe(false)   // ← the hole
  })

  it('every law-firm combination is same-side', () => {
    const partner = P('Law Firm Partner'), attorney = P('Law firm attorney')
    for (const [x, y] of [[partner, partner], [partner, attorney], [attorney, attorney]] as const)
      expect(isSameSideLegalPair(x, y)).toBe(true)
  })

  it('cross-market pairs are never same-side', () => {
    const attorney = P('Law firm attorney')
    for (const other of ['In-house Counsel', 'Compliance', 'Legal Operations', 'Consultant', null])
      expect(isSameSideLegalPair(attorney, P(other))).toBe(false)
  })

  // ── The gate itself. A ranking penalty cannot express "never": a penalised score still wins
  // when nothing else is available, which is how 14 same-side pairs reached a review batch.
  it('the generator gates on isSameSideLegalPair, not the partner-only predicate', () => {
    expect(GEN).toMatch(/if \(isSameSideLegalPair\(userA, userB\)\) continue/)
  })

  it('the gate sits with the other HARD exclusions, before scoring', () => {
    const gate  = GEN.indexOf('isSameSideLegalPair(userA, userB)')
    const score = GEN.indexOf('scoreMatchV2(userA, userB, scoringCtx)')
    const push  = GEN.indexOf('allPairs.push(')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(score)   // never scored
    expect(gate).toBeLessThan(push)    // never enters the optimizer's pool
  })

  // ── Pass 2 was the reintroduction path. It must no longer be one.
  it('PASS 2 cannot reintroduce a same-side pair on residual capacity', () => {
    expect(GEN).toMatch(
      /const fallbackPairs = allPairs\.filter\(\s*\(e\) => isPartnerPair\(e\.userA, e\.userB\) && !isSameSideLegalPair\(e\.userA, e\.userB\),?\s*\)/,
    )
  })

  it('PASS 1 filters on the full same-side predicate, not the partner-only one', () => {
    expect(GEN).toMatch(/const primaryPairs = allPairs\.filter\(\(e\) => !isSameSideLegalPair\(e\.userA, e\.userB\)\)/)
  })

  // ── Honest about the detection limit: the gate is only as good as role_type hygiene.
  it('role_type drift defeats the classifier, and the code says so', () => {
    for (const drift of ['Lawfirm attorney', 'Law-firm Attorney', 'Attorney', 'Partner'])
      expect(lawFirmRole(P(drift)), drift).toBeNull()
    expect(readFileSync('app/api/admin/generate-batch/route.ts', 'utf8'))
      .toMatch(/DETECTION LIMIT/)
  })
})
