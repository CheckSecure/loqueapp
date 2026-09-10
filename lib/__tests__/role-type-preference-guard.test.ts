import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { calculateAlignmentScore } from '@/lib/generate-recommendations'

/**
 * ROLE-TYPE PREFERENCE GUARD — the `includes('')` defect.
 *
 * ─── THE DEFECT ───────────────────────────────────────────────────────────────────────────────
 * Two sites in lib/generate-recommendations.ts test a member's intro_preferences against a
 * candidate's role_type with a symmetric substring compare:
 *
 *     prefLower.includes(roleLower) || roleLower.includes(prefLower)
 *
 * When the candidate has no role_type, roleLower is the EMPTY STRING — and
 * `'anything'.includes('')` is true in JavaScript. So a role-less candidate satisfies EVERY
 * non-empty preference, and collects:
 *
 *     calculateAlignmentScore   +30 of the 80-point alignment scale (≈ +20.6 of the final 100)
 *     calculateFinalScore       +4 tierAdjustment
 *
 * The effect is not a missed match. It is the reverse: a role-less member becomes UNIVERSALLY more
 * attractive in every other member's ranking than their actual fit warrants.
 *
 * ─── WHY THIS IS PREVENTIVE, NOT CORRECTIVE ───────────────────────────────────────────────────
 * Measured in production before this work: of 138 profile_complete Professionals, ZERO have a null
 * or blank role_type. Both live writers require it — completeOnboarding (app/actions.ts) and
 * updateProfile's D2 gate — so no member is affected today. The hole is app/api/profile/complete,
 * which sets profile_complete = true while validating only title, company and location.
 *
 * It becomes systematic at Step 4: every Andrel Next member has role_type = NULL by design.
 *
 * ─── THIS COMMIT CHANGES NO PRODUCTION SOURCE ─────────────────────────────────────────────────
 * Every expectation below was CAPTURED from the current implementation and frozen, including the
 * defect itself — the tests marked CURRENT BEHAVIOUR record what the code does today so the fix's
 * effect is a visible delta rather than a claim. The next commit flips exactly those, and nothing
 * else in this file may move.
 *
 * calculateAlignmentScore is exported and contains no Math.random, so it is goldened at EXACT
 * equality. calculateFinalScore is not exported and calls Math.random in three branches; it is
 * covered structurally here and behaviourally through the shared predicate after the fix.
 */

const GEN = readFileSync('lib/generate-recommendations.ts', 'utf8')
const ROUTE = readFileSync('app/api/profile/complete/route.ts', 'utf8')

afterEach(() => { vi.restoreAllMocks() })

type P = Record<string, any>

/** A candidate carrying only the fields calculateAlignmentScore reads. */
const cand = (over: P = {}): P => ({
  role_type: 'General Counsel', seniority: 'Senior', expertise: [], city: null, state: null, ...over,
})
/** A viewer carrying only the fields calculateAlignmentScore reads. */
const viewer = (over: P = {}): P => ({
  intro_preferences: [], seniority: 'Senior', expertise: [], city: null, state: null, ...over,
})

const align = (v: P, c: P) => calculateAlignmentScore(v, c)

// ═══ 1. THE SCALE, PINNED ═════════════════════════════════════════════════════════════════════
//
// alignmentScore = roleMatch(30) + seniorityFit(20) + min(sharedExpertise*5, 15) + location(15/10/5)
// normalised as (score / 80) * 100. Every number below is captured, not derived.
describe('1. the alignment scale as it stands today', () => {
  it('no preferences, matching seniority, no expertise, no location → the location floor only', () => {
    // 0 + 20 + 0 + 5 = 25 of 80 → 31.25
    expect(align(viewer(), cand())).toBe(31.25)
  })

  it('location always contributes at least 5, even with nothing in common', () => {
    expect(align(viewer({ seniority: 'Junior' }), cand({ seniority: 'Executive' }))).toBe(6.25)
  })

  it('same city → 15, same state only → 10, neither → 5', () => {
    const v = (over: P) => viewer({ seniority: null, ...over })
    const c = (over: P) => cand({ seniority: 'X', ...over })
    expect(align(v({ city: 'Boston', state: 'MA' }), c({ city: 'Boston', state: 'MA' }))).toBe(18.75)
    expect(align(v({ city: 'Boston', state: 'MA' }), c({ city: 'Worcester', state: 'MA' }))).toBe(12.5)
    expect(align(v({ city: 'Boston', state: 'MA' }), c({ city: 'Austin', state: 'TX' }))).toBe(6.25)
  })

  it('shared expertise contributes 5 each, capped at 15', () => {
    const v = (e: string[]) => viewer({ seniority: null, expertise: e })
    const c = (e: string[]) => cand({ seniority: 'X', expertise: e })
    expect(align(v(['Privacy']), c(['Privacy']))).toBe(12.5)
    expect(align(v(['Privacy', 'Tax']), c(['Privacy', 'Tax']))).toBe(18.75)
    expect(align(v(['A', 'B', 'C', 'D']), c(['A', 'B', 'C', 'D']))).toBe(25)
  })

  it('seniority: equal → 20, the two adjacency rules → 10, otherwise → 0', () => {
    expect(align(viewer({ seniority: 'Senior' }), cand({ seniority: 'Senior' }))).toBe(31.25)
    expect(align(viewer({ seniority: 'Mid-Level' }), cand({ seniority: 'Senior' }))).toBe(18.75)
    expect(align(viewer({ seniority: 'Senior' }), cand({ seniority: 'Executive' }))).toBe(18.75)
    expect(align(viewer({ seniority: 'Junior' }), cand({ seniority: 'Executive' }))).toBe(6.25)
  })
})

// ═══ 2. VALID ROLES — THE BEHAVIOUR THAT MUST NOT MOVE ════════════════════════════════════════
//
// These are the fixtures the fix is measured against. Every one of them must be byte-identical
// afterwards; if any moves, the fix changed real matching and is wrong.
describe('2. a candidate WITH a real role_type — frozen', () => {
  it('an exact preference/role match scores the +30', () => {
    // 30 + 20 + 0 + 5 = 55 of 80 → 68.75
    expect(align(viewer({ intro_preferences: ['General Counsel'] }), cand({ role_type: 'General Counsel' }))).toBe(68.75)
  })

  it('a preference that is a SUBSTRING of the role matches (role contains pref)', () => {
    expect(align(viewer({ intro_preferences: ['Counsel'] }), cand({ role_type: 'General Counsel' }))).toBe(68.75)
  })

  it('a preference that CONTAINS the role matches (pref contains role)', () => {
    expect(align(viewer({ intro_preferences: ['Senior General Counsel'] }), cand({ role_type: 'General Counsel' }))).toBe(68.75)
  })

  it('matching is case-insensitive', () => {
    expect(align(viewer({ intro_preferences: ['GENERAL COUNSEL'] }), cand({ role_type: 'general counsel' }))).toBe(68.75)
  })

  it('a NON-matching valid role scores nothing from this term', () => {
    expect(align(viewer({ intro_preferences: ['Investor'] }), cand({ role_type: 'General Counsel' }))).toBe(31.25)
  })

  it('one match among several preferences is enough', () => {
    expect(align(viewer({ intro_preferences: ['Investor', 'Founder', 'Counsel'] }), cand({ role_type: 'General Counsel' }))).toBe(68.75)
  })

  it('an empty preference list never matches, whatever the role', () => {
    expect(align(viewer({ intro_preferences: [] }), cand({ role_type: 'General Counsel' }))).toBe(31.25)
  })

  it('a non-array intro_preferences is treated as empty', () => {
    for (const bad of [null, undefined, 'General Counsel', {}, 7]) {
      expect(align(viewer({ intro_preferences: bad }), cand({ role_type: 'General Counsel' }))).toBe(31.25)
    }
  })
})

// ═══ 3. THE DEFECT, RECORDED AS IT IS TODAY ═══════════════════════════════════════════════════
//
// CURRENT BEHAVIOUR. These four are the ONLY expectations in this file that the fix commit may
// change, and it must change all four to 31.25 — the same score a non-matching valid role gets.
describe('3. CURRENT BEHAVIOUR: an empty role_type matches every preference', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
  ])('%s role_type currently collects the full +30', (_label, role) => {
    const scored = align(viewer({ intro_preferences: ['Investor'] }), cand({ role_type: role }))
    // 30 + 20 + 0 + 5 = 55 of 80 → 68.75, identical to a genuine match.
    expect(scored).toBe(68.75)
    // ...and that is the same score a REAL match earns, which is the harm.
    expect(scored).toBe(align(viewer({ intro_preferences: ['General Counsel'] }), cand({ role_type: 'General Counsel' })))
  })

  it('CURRENT BEHAVIOUR: it fires for EVERY preference value, not a particular one', () => {
    for (const pref of ['Investor', 'Founder', 'zzzz', 'Legal', '🙂']) {
      expect(align(viewer({ intro_preferences: [pref] }), cand({ role_type: null }))).toBe(68.75)
    }
  })

  it('WHITESPACE-ONLY does NOT currently match — the defect is the EMPTY string specifically', () => {
    // Corrected against the implementation rather than assumed. `'investor'.includes('   ')` is
    // FALSE: a whitespace string is a real substring test, not the empty-string special case. So
    // '   ' already scores like a non-match today, and the fix must leave that at 31.25 rather than
    // change it. Recorded because the distinction is easy to get backwards, and because a fix that
    // trims will pass through this case without altering it.
    expect(align(viewer({ intro_preferences: ['Investor'] }), cand({ role_type: '   ' }))).toBe(31.25)
    expect('investor'.includes('   ')).toBe(false)
  })

  it("the cause is JavaScript's includes('') — pinned so the reason survives the fix", () => {
    expect('anything'.includes('')).toBe(true)
    expect(''.includes('')).toBe(true)
  })
})

// ═══ 4. BOTH SITES, AND THE DUPLICATION THAT CAUSED IT ════════════════════════════════════════
describe('4. the defect exists twice, in two functions', () => {
  it('site 1 is in calculateAlignmentScore and is worth 30', () => {
    const fn = GEN.slice(GEN.indexOf('export function calculateAlignmentScore'), GEN.indexOf('alignmentScore += 30'))
    expect(fn).toMatch(/prefLower\.includes\(roleLower\) \|\| roleLower\.includes\(prefLower\)/)
  })

  it('site 2 is in calculateFinalScore and is worth 4', () => {
    const fn = GEN.slice(GEN.indexOf('function calculateFinalScore'), GEN.indexOf('tierAdjustment += 4'))
    expect(fn).toMatch(/prefLower\.includes\(candidateRole\) \|\| candidateRole\.includes\(prefLower\)/)
  })

  it('CURRENT BEHAVIOUR: the two AFFECTED comparisons are written out separately, not shared', () => {
    // The module holds FOUR symmetric-includes comparisons. Only two are affected.
    const all = Array.from(GEN.matchAll(/\.includes\([a-zA-Z]+\) \|\| [a-zA-Z]+\.includes\(/g))
    expect(all.length).toBe(4)
  })

  it('the OTHER TWO includes-sites are already guarded and must NOT be touched', () => {
    // targetedRequest role/industry matching (lines ~310 and ~320) sits behind truthy guards that
    // already exclude null, undefined and '' on both sides. They are not part of this defect, and a
    // well-meaning sweep of every `.includes(` in the file would change matching that works.
    expect(GEN).toMatch(/if \(targetedRequest\.role && candidate\.role_type\) \{/)
    expect(GEN).toMatch(/if \(targetedRequest\.industry && candidate\.industry\) \{/)
  })

  it('the BATCH scorer already guards this correctly — the fix mirrors it, not invents it', () => {
    const ipm = readFileSync('lib/matching/introPreferenceMatch.ts', 'utf8')
    expect(ipm).toMatch(/if \(!p \|\| !r\) return false/)
  })
})

// ═══ 5. /api/profile/complete — THE HOLE, AS IT IS TODAY ══════════════════════════════════════
describe('5. CURRENT BEHAVIOUR: profile completion does not verify role_type', () => {
  it('it re-reads STORED values rather than trusting the request body', () => {
    expect(ROUTE).toMatch(/\.from\('profiles'\)\s*\n\s*\.select\('title, company, location'\)\s*\n\s*\.eq\('id', user\.id\)/)
    expect(ROUTE).toMatch(/createAdminClient\(\)/)
  })

  it('it validates title, company and location', () => {
    expect(ROUTE).toContain('Professional title is required.')
    expect(ROUTE).toContain('Company or organization is required.')
    expect(ROUTE).toMatch(/validateLocation\(identity\?\.location\)/)
  })

  it('CURRENT BEHAVIOUR: role_type appears nowhere in the route', () => {
    expect(ROUTE).not.toMatch(/role_type/)
  })

  it('CURRENT BEHAVIOUR: member_type appears nowhere either', () => {
    expect(ROUTE).not.toMatch(/member_type|communityOf/)
  })

  it('a failed identity read is a 503, and it precedes every validation', () => {
    // Load-bearing ordering: the route\'s own header records that a read failure was once reported
    // as "Professional title is required.", so the error path must stay first.
    expect(ROUTE).toMatch(/if \(identityError\) \{/)
    expect(ROUTE).toMatch(/status: 503/)
    // Compared on EXECUTABLE lines. The route's header comment quotes the string
    // "Professional title is required." while explaining the very bug this ordering prevents, so a
    // raw file-offset comparison finds the prose first and reports a failure against documentation.
    const code = ROUTE.split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
      .join('\n')
    expect(code.indexOf('if (identityError)')).toBeLessThan(code.indexOf('Professional title is required.'))
  })

  it('it is the only writer that sets profile_complete without requiring role_type', () => {
    // completeOnboarding and updateProfile both require it; this route is the gap.
    expect(ROUTE).toMatch(/profile_complete: true, onboarding_step: 2/)
    const actions = readFileSync('app/actions.ts', 'utf8')
    expect(actions).toMatch(/if \(!roleType\) return \{ error: 'Please select your professional role' \}/)
  })
})

// ═══ 6. WHAT MUST NOT CHANGE ══════════════════════════════════════════════════════════════════
describe('6. the surfaces this hotfix must leave alone', () => {
  it('completeOnboarding still requires role_type unconditionally', () => {
    const actions = readFileSync('app/actions.ts', 'utf8')
    const calls = Array.from(actions.matchAll(/if \(!roleType\) return \{ error: 'Please select your professional role' \}/g))
    expect(calls.length).toBe(2)   // completeOnboarding + updateProfile's D2 gate
  })

  it('the batch scorer is untouched by this hotfix', () => {
    const bs = readFileSync('lib/matching/batch-scoring.ts', 'utf8')
    expect(bs).toMatch(/preferenceMatchesRole\(p, candidate\.role_type\)/)
    expect(bs).toMatch(/ctx\.semantics === 'next'/)   // Step 3.5, unchanged
  })

  it('matching eligibility still does not read role_type', () => {
    const el = readFileSync('lib/matching/eligibility.ts', 'utf8')
    expect(el).not.toMatch(/role_type/)
  })

  it('no migration is involved — 100 is still the highest', () => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    const n = readdirSync('supabase/migrations').filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => Number(f.slice(0, 3)))
    expect(Math.max(...n)).toBe(100)
  })
})
