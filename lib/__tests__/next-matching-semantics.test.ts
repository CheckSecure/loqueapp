import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  scoreMatch, buildScoringContext, cohortSemantics, relevanceFloorFor,
  BATCH_CONFIG, NEXT_SCORING_CONFIG, algorithmSnapshot,
  type ScoringContext,
} from '@/lib/matching/batch-scoring'
import { partitionByCommunity } from '@/lib/community/memberType'

/**
 * ANDREL NEXT MATCHING SEMANTICS — STEP 3.5.
 *
 * ─── THE ONE THING THAT DIFFERS ───────────────────────────────────────────────────────────────
 * `expertise` means different things in the two communities. A professional answers it as "what I
 * do", and the scorer rewards COMPLEMENTARITY — an identical pair scores zero, because two people
 * doing exactly the same thing are usually competitors. An Andrel Next member answers the same
 * column as "the areas of law I am interested in", and two students both specifically interested in
 * Privacy & Cybersecurity are one of the best introductions the cohort can make.
 *
 * Everything else about the scorer is shared. There is no scoreMatchNext(), no second scoring
 * system to drift, and no argument a caller passes: the semantics are DERIVED from the cohort's own
 * immutable member_type, which is the same value partitionByCommunity already used to build it.
 *
 * ─── DETERMINISTIC COHORTS, STATED FREQUENCIES ────────────────────────────────────────────────
 * Rarity depends on cohort composition, so every cohort below is explicit and every expected score
 * was CAPTURED from the implementation and frozen. No expectation here depends on an accidental
 * fixture frequency.
 */

const ROUTE = readFileSync('app/api/admin/generate-batch/route.ts', 'utf8')
const SCORING = readFileSync('lib/matching/batch-scoring.ts', 'utf8')

const eligible = {
  account_status: 'active', profile_complete: true,
  is_test_account: false, is_admin: false, matching_paused: false,
}

type P = Record<string, any>

/**
 * A law student as Step 4 will actually store one: school in `company`, degree in `title`,
 * practice interests in `expertise`, goals in `purposes`, personal interests in `interests`.
 * role_type and seniority stay NULL — the two Professional gates a student never fills.
 */
function student(id: string, over: P = {}): P {
  return {
    id, email: `${id}@example.com`, member_type: 'next',
    ...eligible,
    role_type: null, seniority: null, mentorship_role: null,
    expertise: '', purposes: [], interests: [], intro_preferences: [],
    subscription_tier: 'free', city: null, state: null,
    geographic_scope: 'us-wide', meeting_format_preference: 'both',
    verification_status: null, trust_score: null,
    boost_score: 0, is_priority: false,
    grad_year: 2028, title: 'J.D. Candidate', company: `${id} Law`,
    ...over,
  }
}

afterEach(() => { vi.restoreAllMocks() })

// ═══ 1. THE SEMANTICS ARE DERIVED, NOT PASSED ═════════════════════════════════════════════════
describe('1. a cohort scores under its own community, read from immutable member_type', () => {
  it('an all-Next cohort derives next semantics', () => {
    expect(cohortSemantics([student('a'), student('b')])).toBe('next')
  })

  it('an all-Professional cohort derives professional semantics', () => {
    const pro = (id: string) => ({ ...student(id), member_type: 'professional' })
    expect(cohortSemantics([pro('a'), pro('b')])).toBe('professional')
  })

  it('a MIXED cohort fails closed to professional and reports it', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mixed = [student('a'), { ...student('b'), member_type: 'professional' }]
    expect(cohortSemantics(mixed, 'test')).toBe('professional')
    expect(err.mock.calls.flat().join(' ')).toMatch(/MIXED COMMUNITY/)
    // ...and it names no member.
    expect(err.mock.calls.flat().join(' ')).not.toMatch(/a@example|b@example/)
  })

  it('an unrecognised, null or absent member_type fails closed to professional', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const mt of ['student', 'NEXT', '', null, undefined]) {
      expect(cohortSemantics([{ ...student('a'), member_type: mt }])).toBe('professional')
    }
  })

  it('an EMPTY cohort is professional', () => {
    expect(cohortSemantics([])).toBe('professional')
    expect(cohortSemantics(null as any)).toBe('professional')
  })

  it('buildScoringContext derives it — there is no parameter to get wrong', () => {
    expect(buildScoringContext([student('a'), student('b')], undefined, 't').semantics).toBe('next')
    // The signature takes profiles, a config and a code path. No community argument exists.
    expect(SCORING).toMatch(/export function buildScoringContext\(profiles: any\[\], config: ScoringConfig = SCORING_CONFIG, codePath = 'buildScoringContext'\): ScoringContext/)
    expect(SCORING).toMatch(/semantics: cohortSemantics\(profiles, codePath\)/)
  })

  it('nothing client-supplied can reach the derivation', () => {
    const fn = SCORING.slice(SCORING.indexOf('export function cohortSemantics'), SCORING.indexOf('export function relevanceFloorFor'))
    expect(fn).not.toMatch(/req|request|body|headers|searchParams|memberType|localStorage/)
    // It reads communityOf, which reads member_type and returns null for anything unrecognised.
    expect(fn).toMatch(/communityOf\(/)
  })

  it('the route derives it per PARTITION — the cohorts are disjoint by construction', () => {
    expect(ROUTE).toMatch(/const partitions = partitionByCommunity\(profiles as any\[\]\)/)
    expect(ROUTE).toMatch(/const scoringCtx: ScoringContext = buildScoringContext\(cohort, undefined, 'generate-batch'\)/)
    const parts = partitionByCommunity([student('n1'), { ...student('p1'), member_type: 'professional' }])
    expect(parts.get('next')!.map((m: any) => m.id)).toEqual(['n1'])
    expect(parts.get('professional')!.map((m: any) => m.id)).toEqual(['p1'])
  })
})

// ═══ 2. NEXT EXPERTISE SEMANTICS ══════════════════════════════════════════════════════════════
//
// A fixed 8-student cohort with stated practice-area frequencies, so every score below is stable.
//   Privacy 4/8 · Corporate 4/8 · Litigation 2/8 · Technology 2/8
describe('2. shared practice interests are a positive signal for Next', () => {
  function cohortWith(a: P, b: P) {
    const filler = [
      student('f1', { expertise: 'Privacy' }),
      student('f2', { expertise: 'Corporate' }),
      student('f3', { expertise: 'Corporate' }),
      student('f4', { expertise: 'Litigation' }),
      student('f5', { expertise: 'Technology' }),
      student('f6', { expertise: 'Privacy,Corporate' }),
    ]
    const cohort = [a, b, ...filler]
    return { cohort, ctx: buildScoringContext(cohort, undefined, 'next-exp') }
  }
  const sc = (aExp: string, bExp: string) => {
    const a = student('a', { expertise: aExp }), b = student('b', { expertise: bExp })
    const { ctx } = cohortWith(a, b)
    return scoreMatch(a, b, ctx)
  }

  // Baseline: two blank students score the meeting-format bonus only.
  it('the Next baseline is the same 10 as Professional', () => {
    expect(sc('', '')).toBe(10)
  })

  it('Privacy <-> Privacy is a POSITIVE signal — the case Professional scores at zero', () => {
    expect(sc('Privacy', 'Privacy')).toBe(22)
  })

  it('ONE accurately-chosen area is enough — no minimum selection is required', () => {
    // The whole point: a student who honestly picks a single area is not penalised for it.
    expect(sc('Litigation', 'Litigation')).toBeGreaterThan(10)
    expect(sc('Privacy', 'Privacy')).toBeGreaterThan(10)
  })

  it('a RARER shared area scores higher than a common one', () => {
    expect(sc('Litigation', 'Litigation')).toBeGreaterThan(sc('Privacy', 'Privacy'))
  })

  it('MULTIPLE partial overlap scores on the meaningful overlap', () => {
    // Corporate+Privacy <-> Privacy+Technology → Privacy is the shared item.
    expect(sc('Corporate,Privacy', 'Privacy,Technology')).toBe(23)
  })

  it('two shared areas apply the same geometric decay as purposes and interests', () => {
    expect(sc('Privacy,Corporate', 'Privacy,Corporate')).toBe(36)
  })

  it('NO overlap is zero signal — and NOT a rejection', () => {
    // Corporate <-> Litigation contributes nothing here, but the pair still scores whatever its
    // other signals earn. Nothing about this term removes an edge.
    expect(sc('Corporate', 'Litigation')).toBe(10)
  })

  it('an EMPTY set on either side is zero — this is how "still exploring" behaves', () => {
    expect(sc('', 'Privacy')).toBe(10)
    expect(sc('Privacy', '')).toBe(10)
    expect(sc('', '')).toBe(10)
  })

  it('"Exploring" is NOT implemented as a stored sentinel anywhere', () => {
    expect(SCORING).not.toMatch(/Exploring|EXPLORING|not_sure|notSure/)
    expect(ROUTE).not.toMatch(/Exploring|EXPLORING/)
  })

  it('it reuses overlapScore rather than inventing a parallel formula', () => {
    expect(SCORING).toMatch(/score \+= overlapScore\(sharedExpertise, ctx\.expertiseRarity,\s*\n\s*NEXT_SCORING_CONFIG\.expertiseBase, NEXT_SCORING_CONFIG\.expertiseDecay\)/)
    expect(NEXT_SCORING_CONFIG.expertiseBase).toBe(14)
    expect(NEXT_SCORING_CONFIG.expertiseDecay).toBe(0.75)
  })

  it('there is NO scoreMatchNext — one scorer, one branch', () => {
    expect(SCORING).not.toMatch(/scoreMatchNext|scoreNextMatch/)
    const matches = Array.from(SCORING.matchAll(/export function scoreMatch/g))
    expect(matches).toHaveLength(1)
  })
})

// ═══ 3. PROFESSIONAL EXPERTISE IS UNTOUCHED ═══════════════════════════════════════════════════
describe('3. the Professional branch still scores complementarity', () => {
  const pro = (id: string, over: P = {}) => ({ ...student(id, over), member_type: 'professional' })

  function proScore(aExp: string, bExp: string) {
    const a = pro('a', { expertise: aExp }), b = pro('b', { expertise: bExp })
    const cohort = [a, b, pro('f1', { expertise: 'Privacy' }), pro('f2', { expertise: 'Corporate' })]
    return scoreMatch(a, b, buildScoringContext(cohort, undefined, 'pro-exp'))
  }

  it('identical sets still score ZERO for professionals', () => {
    expect(proScore('Privacy', 'Privacy')).toBe(10)
  })

  it('strictly partial overlap still scores the x8 term', () => {
    expect(proScore('Privacy,Litigation', 'Privacy,Tax')).toBe(18)
  })

  it('the SAME two profiles score differently under the two semantics — that is the change', () => {
    const a = { expertise: 'Privacy' }, b = { expertise: 'Privacy' }
    const asPro = [{ ...pro('a', a) }, { ...pro('b', b) }]
    const asNext = [student('a', a), student('b', b)]
    const proResult = scoreMatch(asPro[0], asPro[1], buildScoringContext(asPro, undefined, 'x'))
    const nextResult = scoreMatch(asNext[0], asNext[1], buildScoringContext(asNext, undefined, 'y'))
    expect(proResult).toBe(10)
    expect(nextResult).toBeGreaterThan(proResult)
  })
})

// ═══ 4. THE FLOORS ════════════════════════════════════════════════════════════════════════════
describe('4. each community is measured against its own floor', () => {
  it('Professional remains EXACTLY 40', () => {
    expect(BATCH_CONFIG.minRelevanceScore).toBe(40)
    expect(relevanceFloorFor('professional')).toBe(40)
  })

  it('Next is 28', () => {
    expect(NEXT_SCORING_CONFIG.minRelevanceScore).toBe(28)
    expect(relevanceFloorFor('next')).toBe(28)
  })

  it('the route selects the floor from the cohort semantics, not from a constant', () => {
    expect(ROUTE).toMatch(/const cohortFloor = relevanceFloorFor\(scoringCtx\.semantics\)/)
    expect(ROUTE).toMatch(/if \(avgScore < cohortFloor\) \{ pairsCutByScoreFloor\+\+; continue \}/)
    // The old inline constant is no longer the gate.
    expect(ROUTE).not.toMatch(/if \(avgScore < MIN_RELEVANCE_SCORE\)/)
  })

  it('28 is documented as PROVISIONAL, with the reason', () => {
    const block = SCORING.slice(SCORING.indexOf('export const NEXT_SCORING_CONFIG'), SCORING.indexOf('export const SCORING_CONFIG'))
    expect(block).toMatch(/PROVISIONAL/)
    expect(block).toMatch(/no production Next score distribution yet|NO PRODUCTION NEXT SCORE DISTRIBUTION YET/i)
  })

  it('the onboarding/reciprocal threshold is NOT touched by this change', () => {
    const gen = readFileSync('lib/generate-recommendations.ts', 'utf8')
    expect(gen).toMatch(/c\.finalScore >= 10/)
    expect(gen).not.toMatch(/relevanceFloorFor|NEXT_SCORING_CONFIG|cohortSemantics/)
    // calculateAlignmentScore is deliberately untouched in this branch.
    expect(gen).toMatch(/alignmentScore \+= Math\.min\(sharedExpertise\.length \* 5, 15\)/)
  })
})

// ═══ 5. THE FOUR SCENARIOS ════════════════════════════════════════════════
//
// ONE explicit 14-student cohort shared by all four, so rarity is identical across them and the
// scores are directly comparable. The frequencies are not described in a comment and hoped for —
// they are ASSERTED by the first test in this block, so a later edit to a fixture member cannot
// silently move every expected score.
//
// NOT REPRESENTED, AND DELIBERATELY NOT FAKED: "targeting New York" / "targeting Chicago". There
// is no target-market column in the schema. `city`/`state` are where a student IS, which for a law
// student is their school's city. Scenarios A and C are scored on that, not on an invented field.
describe('5. the audit scenarios, executable', () => {
  // EVERY scenario pair shares exactly ONE goal, and it is the same near-universal one. That is
  // deliberate experimental design: it holds the purposes term constant across all four, so the
  // only things that differ between A, B, C and D are expertise, geography and personal interests —
  // which is exactly what the four scenarios exist to test.
  const NET = 'Build my professional network'      // held by every member — the cheapest shared goal
  const EXPLORE = 'Explore practice areas'          // 3 of 14, held only by fillers
  const CORP = 'Corporate / M&A'                    // 4 of 14
  const PRIV = 'Privacy & Cybersecurity'            // 3 of 14
  const LIT = 'Litigation'                          // 3 of 14

  const A1 = student('a1', { company: 'Georgetown University Law Center', city: 'Washington', state: 'DC', expertise: CORP, purposes: [NET], interests: ['Running'], grad_year: 2027 })
  const A2 = student('a2', { company: 'George Washington University Law School', city: 'Washington', state: 'DC', expertise: CORP, purposes: [NET], interests: ['Running'], grad_year: 2027 })

  // "Both generally want to meet students outside their school" is modelled as the near-universal
  // networking goal — the only goal they share, and the cheapest one in the cohort.
  const B1 = student('b1', { company: 'Harvard Law School', city: 'Cambridge', state: 'MA', expertise: '', purposes: [NET], interests: [], grad_year: 2029 })
  const B2 = student('b2', { company: 'University of Michigan Law School', city: 'Ann Arbor', state: 'MI', expertise: '', purposes: [NET], interests: [], grad_year: 2029 })

  const C1 = student('c1', { company: 'Georgetown University Law Center', city: 'Washington', state: 'DC', expertise: CORP, purposes: [NET], interests: [], grad_year: 2027 })
  const C2 = student('c2', { company: 'Northwestern Pritzker School of Law', city: 'Chicago', state: 'IL', expertise: LIT, purposes: [NET], interests: [], grad_year: 2026 })

  const D1 = student('d1', { company: 'UC Berkeley School of Law', city: 'Berkeley', state: 'CA', expertise: PRIV, purposes: [NET], interests: ['Travel', 'Music', 'Running'], grad_year: 2027 })
  const D2 = student('d2', { company: 'George Washington University Law School', city: 'Washington', state: 'DC', expertise: PRIV, purposes: [NET], interests: ['Travel', 'Music', 'Running'], grad_year: 2027 })

  const FILL = [
    student('g1', { expertise: CORP, purposes: [NET], interests: ['Travel'] }),
    student('g2', { expertise: LIT, purposes: [NET, EXPLORE], interests: ['Music'] }),  // EXPLORE lives here
    student('g3', { expertise: PRIV, purposes: [NET], interests: ['Running'] }),
    student('g4', { expertise: LIT, purposes: [NET], interests: [] }),
    student('g5', { expertise: '', purposes: [NET], interests: [] }),
    student('g6', { expertise: '', purposes: [NET], interests: [] }),
  ]

  const COHORT = [A1, A2, B1, B2, C1, C2, D1, D2, ...FILL]
  const ctx: ScoringContext = buildScoringContext(COHORT, undefined, 'scenarios')
  const FLOOR = relevanceFloorFor('next')

  const avg = (a: P, b: P) => (scoreMatch(a, b, ctx) + scoreMatch(b, a, ctx)) / 2

  it('the cohort composition is EXACTLY what the scores assume', () => {
    expect(ctx.semantics).toBe('next')
    expect(COHORT).toHaveLength(14)
    const count = (field: 'purposes' | 'interests', v: string) =>
      COHORT.filter((m: P) => (m[field] as string[]).includes(v)).length
    const expCount = (v: string) => COHORT.filter((m: P) => String(m.expertise).split(',').includes(v)).length
    expect(count('purposes', NET)).toBe(14)
    expect(count('purposes', EXPLORE)).toBe(1)
    expect(expCount(CORP)).toBe(4)
    expect(expCount(PRIV)).toBe(3)
    expect(expCount(LIT)).toBe(3)
    expect(COHORT.filter((m: P) => String(m.expertise) === '').length).toBe(4)
    expect(count('interests', 'Running')).toBe(5)
    expect(count('interests', 'Travel')).toBe(3)
    expect(count('interests', 'Music')).toBe(3)
  })

  it('SCENARIO A — Georgetown 2L + GW 2L QUALIFIES', () => {
    // Shared Corporate/M&A, both in Washington DC (their ACTUAL stored city — "targeting New York"
    // has no field and is not modelled), shared running, one near-universal networking goal.
    const s = avg(A1, A2)
    expect(s).toBe(42)
    expect(s).toBeGreaterThanOrEqual(FLOOR)
  })

  it('SCENARIO B — two Exploring 1Ls does NOT qualify', () => {
    // Empty expertise (how "still exploring" is stored), different geography, no shared interests,
    // and the one goal they share is held by every member of the cohort, so rarity damps it to the
    // clamp floor. The threshold is NOT lowered to rescue this pair.
    const s = avg(B1, B2)
    expect(s).toBe(13)
    expect(s).toBeLessThan(FLOOR)
  })

  it('SCENARIO C — complementary practice areas does NOT qualify on representable data', () => {
    // Corporate/M&A <-> Litigation share nothing, and "both targeting Chicago" is NOT REPRESENTED:
    // there is no target-market column, and their stored cities (Washington DC / Chicago) differ.
    // What would have carried this pair is a field that does not exist — not the expertise rule.
    const s = avg(C1, C2)
    expect(s).toBe(13)
    expect(s).toBeLessThan(FLOOR)
  })

  it('SCENARIO D — shared practice area + multiple shared interests BEATS the geographic gap', () => {
    const s = avg(D1, D2)
    expect(s).toBe(55)
    expect(s).toBeGreaterThanOrEqual(FLOOR)
  })

  it('the two qualifying pairs rank above the two that do not', () => {
    expect(avg(D1, D2)).toBeGreaterThan(avg(A1, A2))
    expect(avg(A1, A2)).toBeGreaterThan(avg(B1, B2))
    expect(avg(A1, A2)).toBeGreaterThan(avg(C1, C2))
  })

  it('B and C score IDENTICALLY, and that is the honest result', () => {
    // Neither pair has a single representable shared signal beyond the cheapest goal in the cohort.
    // For B that is correct and expected — two undecided 1Ls with nothing in common. For C it is
    // the finding: what should have carried that pair is a shared TARGET MARKET, and no such column
    // exists, so the algorithm cannot see the one thing that made them a plausible introduction.
    expect(avg(C1, C2)).toBe(avg(B1, B2))
  })

  it('under PROFESSIONAL semantics, A is cut — this is the pair 3.5 rescues', () => {
    const asPro = COHORT.map((m) => ({ ...m, member_type: 'professional' }))
    const proCtx = buildScoringContext(asPro, undefined, 'scenarios-pro')
    expect(proCtx.semantics).toBe('professional')
    const proAvg = (ai: number, bi: number) =>
      (scoreMatch(asPro[ai], asPro[bi], proCtx) + scoreMatch(asPro[bi], asPro[ai], proCtx)) / 2
    // A: shared Corporate/M&A scores ZERO under complementarity, so the pair falls below 40.
    expect(proAvg(0, 1)).toBe(30)
    expect(proAvg(0, 1)).toBeLessThan(BATCH_CONFIG.minRelevanceScore)
  })

  it('under PROFESSIONAL semantics D is cut too — narrowly, and on the wrong signal', () => {
    // D's three shared personal interests carry it to 39, one point under the Professional floor,
    // while its shared practice area — the strongest thing about the pair — contributes NOTHING
    // under complementarity. Both halves of that are worth stating: the pair was nearly rescued by
    // an accident, and the signal that should have carried it was the one being discarded.
    const asPro = COHORT.map((m) => ({ ...m, member_type: 'professional' }))
    const proCtx = buildScoringContext(asPro, undefined, 'scenarios-pro2')
    const proD = (scoreMatch(asPro[6], asPro[7], proCtx) + scoreMatch(asPro[7], asPro[6], proCtx)) / 2
    expect(proD).toBe(39)
    expect(proD).toBeLessThan(BATCH_CONFIG.minRelevanceScore)
    expect(avg(D1, D2)).toBeGreaterThan(proD)
  })
})

// ═══ 6. THE CONFIG SNAPSHOT ═══════════════════════════════════════════════════════════════════
describe('6. Next configuration is part of the reproducible snapshot', () => {
  it('the snapshot records the Next constants', () => {
    expect((algorithmSnapshot() as any).next)
      .toEqual({ expertiseBase: 14, expertiseDecay: 0.75, minRelevanceScore: 28 })
  })

  it('it is NOT hidden outside the snapshot to preserve the old hash', () => {
    expect(SCORING).toMatch(/next: NEXT_SCORING_CONFIG,/)
    const snap = SCORING.slice(SCORING.indexOf('export function algorithmSnapshot'), SCORING.indexOf('function canonicalJson'))
    expect(snap).toContain('next: NEXT_SCORING_CONFIG')
  })
})

// ═══ 7. NOTHING ELSE MOVED ════════════════════════════════════════════════════════════════════
describe('7. the boundaries this step must not touch', () => {
  it('community segmentation helpers are unchanged', () => {
    const mt = readFileSync('lib/community/memberType.ts', 'utf8')
    for (const fn of ['sameCommunity', 'filterSameCommunity', 'partitionByCommunity', 'countUnknownCommunity']) {
      expect(mt).toMatch(new RegExp(`export function ${fn}`))
    }
    expect(mt).toMatch(/return isMemberType\(raw\) \? raw : null/)
  })

  it('onboarding, completeOnboarding and the student form are untouched', () => {
    const actions = readFileSync('app/actions.ts', 'utf8')
    expect(actions).not.toMatch(/cohortSemantics|relevanceFloorFor|NEXT_SCORING_CONFIG|expertiseRarity/)
    const form = readFileSync('components/OnboardingForm.tsx', 'utf8')
    expect(form).not.toMatch(/interests|NEXT_SCORING_CONFIG/)
  })

  it('no migration was added — 100 is still the highest', () => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    const n = readdirSync('supabase/migrations').filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => Number(f.slice(0, 3)))
    expect(Math.max(...n)).toBe(100)
  })

  it('mentorship fields remain inert for ordinary matching', () => {
    expect(SCORING).not.toMatch(/seeking_next_mentorship|open_to_next_mentorship/)
    expect(ROUTE).not.toMatch(/seeking_next_mentorship|open_to_next_mentorship/)
  })
})
