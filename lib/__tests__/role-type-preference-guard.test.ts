import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { calculateAlignmentScore, looseRoleMatchesPreference } from '@/lib/generate-recommendations'

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
 * ─── THE DELTA, MADE VISIBLE ──────────────────────────────────────────────────────────────────
 * This file shipped one commit EARLIER, against unmodified source, with every expectation captured
 * from the implementation and frozen — including the defect itself. The fix commit then flipped
 * exactly the expectations marked FIXED below, and NOTHING ELSE MOVED: all twenty-four scale and
 * valid-role fixtures are byte-identical before and after, which is the proof that real matching
 * did not change.
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
// FIXED. Before the fix each of these scored 68.75 — identical to a genuine match. They now score
// 31.25, identical to a NON-match, which is the correct answer: an absent role is not a match.
describe('3. FIXED: an empty role_type no longer matches any preference', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
  ])('%s role_type scores exactly like a non-match', (_label, role) => {
    const scored = align(viewer({ intro_preferences: ['Investor'] }), cand({ role_type: role }))
    // 0 + 20 + 0 + 5 = 25 of 80 → 31.25. WAS 68.75.
    expect(scored).toBe(31.25)
    // The same score a genuine non-match earns — no penalty either, just no signal.
    expect(scored).toBe(align(viewer({ intro_preferences: ['Investor'] }), cand({ role_type: 'General Counsel' })))
    // ...and NOT the score a real match earns.
    expect(scored).not.toBe(align(viewer({ intro_preferences: ['General Counsel'] }), cand({ role_type: 'General Counsel' })))
  })

  it('FIXED: no preference value can revive it', () => {
    for (const pref of ['Investor', 'Founder', 'zzzz', 'Legal', '🙂', '']) {
      expect(align(viewer({ intro_preferences: [pref] }), cand({ role_type: null }))).toBe(31.25)
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
describe('4. FIXED: both sites now share ONE predicate', () => {
  it('site 1 — calculateAlignmentScore, worth 30 — calls the shared predicate', () => {
    const fn = GEN.slice(GEN.indexOf('export function calculateAlignmentScore'), GEN.indexOf('alignmentScore += 30'))
    expect(fn).toMatch(/userPrefs\.some\(\(pref: string\) => looseRoleMatchesPreference\(pref, candidate\.role_type\)\)/)
    expect(fn).not.toMatch(/prefLower\.includes\(roleLower\)/)
  })

  it('site 2 — calculateFinalScore, worth 4 — calls the SAME predicate', () => {
    const fn = GEN.slice(GEN.indexOf('function calculateFinalScore'), GEN.indexOf('tierAdjustment += 4'))
    expect(fn).toMatch(/userPrefs\.some\(\(pref: string\) => looseRoleMatchesPreference\(pref, candidate\.role_type\)\)/)
    expect(fn).not.toMatch(/prefLower\.includes\(candidateRole\)/)
  })

  it('the rule is written ONCE — the duplication that let one bug live twice is gone', () => {
    const calls = Array.from(GEN.matchAll(/looseRoleMatchesPreference\(pref, candidate\.role_type\)/g))
    expect(calls.length).toBe(2)
    const defs = Array.from(GEN.matchAll(/export function looseRoleMatchesPreference/g))
    expect(defs.length).toBe(1)
  })

  it('the predicate itself guards empty on BOTH sides, and trims first', () => {
    const fn = GEN.slice(GEN.indexOf('export function looseRoleMatchesPreference'), GEN.indexOf('export function calculateAlignmentScore'))
    expect(fn).toMatch(/const p = String\(pref \?\? ''\)\.trim\(\)\.toLowerCase\(\)/)
    expect(fn).toMatch(/const r = String\(roleType \?\? ''\)\.trim\(\)\.toLowerCase\(\)/)
    expect(fn).toMatch(/if \(!p \|\| !r\) return false/)
    expect(fn).toMatch(/return p\.includes\(r\) \|\| r\.includes\(p\)/)
  })

  it('three symmetric-includes comparisons remain: the predicate, and the two already-guarded ones', () => {
    const all = Array.from(GEN.matchAll(/\.includes\([a-zA-Z]+\) \|\| [a-zA-Z]+\.includes\(/g))
    expect(all.length).toBe(3)
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
    expect(ROUTE).toMatch(/\.select\('title, company, location, member_type, role_type'\)/)
    expect(ROUTE).toMatch(/\.eq\('id', user\.id\)/)
    expect(ROUTE).toMatch(/createAdminClient\(\)/)
  })

  it('it validates title, company and location', () => {
    expect(ROUTE).toContain('Professional title is required.')
    expect(ROUTE).toContain('Company or organization is required.')
    expect(ROUTE).toMatch(/validateLocation\(identity\?\.location\)/)
  })

  it('FIXED: a Professional without a role_type is refused', () => {
    expect(ROUTE).toMatch(/return NextResponse\.json\(\{ error: 'Professional role is required\.' \}, \{ status: 400 \}\)/)
    expect(ROUTE).toMatch(/const roleType = \(identity\?\.role_type \|\| ''\)\.trim\(\)/)
    expect(ROUTE).toMatch(/if \(roleType\.length < 1\)/)
  })

  it('FIXED: Andrel Next is EXEMPT — a student is never asked to invent a Professional role', () => {
    expect(ROUTE).toMatch(/if \(communityOf\(identity\) !== 'next'\) \{/)
  })

  it('the community comes from the STORED row, never from client input', () => {
    expect(ROUTE).toMatch(/import \{ communityOf \} from '@\/lib\/community\/memberType'/)
    // The gate reads `identity`, which is the service_role self-read scoped to user.id.
    const gate = ROUTE.slice(ROUTE.indexOf("if (communityOf(identity) !== 'next')"), ROUTE.indexOf('Professional role is required.') + 60)
    expect(gate).not.toMatch(/req\.|body|headers|searchParams|json\(\)/)
  })

  it('the community check runs AFTER the 503 and AFTER title/company/location', () => {
    const code = ROUTE.split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
      .join('\n')
    const gate = code.indexOf("communityOf(identity) !== 'next'")
    expect(gate).toBeGreaterThan(code.indexOf('if (identityError)'))
    expect(gate).toBeGreaterThan(code.indexOf('Professional title is required.'))
    expect(gate).toBeGreaterThan(code.indexOf('Company or organization is required.'))
    expect(gate).toBeGreaterThan(code.indexOf('validateLocation(identity?.location)'))
    // ...and before the write.
    expect(gate).toBeLessThan(code.indexOf('profile_complete: true, onboarding_step: 2'))
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


// ═══ 7. THE SHARED PREDICATE, DIRECTLY ════════════════════════════════════════════════════════
//
// Site 2 (calculateFinalScore) is not exported and calls Math.random in three branches, so it
// cannot be goldened. Extracting the rule into one predicate is what makes it testable at all:
// these cases cover BOTH sites, because both sites are now this function.
describe('7. looseRoleMatchesPreference', () => {
  it.each([
    ['null role', 'Investor', null],
    ['undefined role', 'Investor', undefined],
    ['empty role', 'Investor', ''],
    ['whitespace-only role', 'Investor', '   '],
    ['tab-only role', 'Investor', '\t'],
    ['null pref', null, 'General Counsel'],
    ['empty pref', '', 'General Counsel'],
    ['whitespace-only pref', '   ', 'General Counsel'],
    ['both empty', '', ''],
  ])('%s -> false', (_label, pref, role) => {
    expect(looseRoleMatchesPreference(pref as any, role as any)).toBe(false)
  })

  it.each([
    ['exact', 'General Counsel', 'General Counsel'],
    ['role contains pref', 'Counsel', 'General Counsel'],
    ['pref contains role', 'Senior General Counsel', 'General Counsel'],
    ['case-insensitive', 'GENERAL COUNSEL', 'general counsel'],
    ['surrounding whitespace is trimmed, not treated as absent', '  Counsel  ', '  General Counsel  '],
  ])('%s -> true', (_label, pref, role) => {
    expect(looseRoleMatchesPreference(pref, role)).toBe(true)
  })

  it('a genuine non-match is still false', () => {
    expect(looseRoleMatchesPreference('Investor', 'General Counsel')).toBe(false)
  })

  it('non-string inputs are coerced safely rather than throwing', () => {
    for (const v of [7, {}, [], true, NaN]) {
      expect(() => looseRoleMatchesPreference(v as any, 'General Counsel')).not.toThrow()
      expect(() => looseRoleMatchesPreference('Investor', v as any)).not.toThrow()
    }
  })
})

// ═══ 8. POOL-LEVEL: THE UNIVERSAL BOOST IS GONE ═══════════════════════════════════════════════
//
// The predicate being correct is not the same as the harm being gone. This ranks a real pool the
// way the generator does — by alignment, which is where the 30 points live — and asserts the
// role-less candidate no longer outranks a genuine match.
describe('8. a role-less candidate no longer wins the ranking', () => {
  const seeker = viewer({ intro_preferences: ['General Counsel'], seniority: 'Senior' })

  const POOL = [
    cand({ role_type: null, seniority: 'Senior' }),               // roleless — was universally boosted
    cand({ role_type: 'General Counsel', seniority: 'Senior' }),  // genuine match
    cand({ role_type: 'Investor', seniority: 'Senior' }),         // genuine non-match
    cand({ role_type: '', seniority: 'Senior' }),                 // roleless (empty string)
  ]

  const ranked = () =>
    POOL.map((c, i) => ({ i, role: String(c.role_type), score: align(seeker, c) }))
        .sort((a, b) => b.score - a.score || a.i - b.i)

  it('the genuine match ranks FIRST, alone at the top', () => {
    const r = ranked()
    expect(r[0].role).toBe('General Counsel')
    expect(r[0].score).toBe(68.75)
    expect(r.filter((x) => x.score === 68.75)).toHaveLength(1)
  })

  it('both role-less candidates rank level with the genuine NON-match, not with the match', () => {
    const byRole = new Map(ranked().map((x) => [x.role, x.score]))
    expect(byRole.get('null')).toBe(31.25)
    expect(byRole.get('')).toBe(31.25)
    expect(byRole.get('Investor')).toBe(31.25)
    expect(byRole.get('General Counsel')).toBe(68.75)
  })

  it('the role-less candidates carry NO advantage over each other or over the non-match', () => {
    const scores = ranked().slice(1).map((x) => x.score)
    expect(new Set(scores).size).toBe(1)
  })

  it('a seeker with NO preferences ranks the whole pool level — the term simply does not fire', () => {
    const none = viewer({ intro_preferences: [], seniority: 'Senior' })
    const scores = POOL.map((c) => align(none, c))
    expect(new Set(scores).size).toBe(1)
    expect(scores[0]).toBe(31.25)
  })
})
