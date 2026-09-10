import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  scoreMatch, buildScoringContext, overlapScore, parseList,
  BATCH_CONFIG, SCORING_CONFIG, algorithmConfigHash, algorithmSnapshot,
  type ScoringContext,
} from '@/lib/matching/batch-scoring'
import { solveGlobalBMatching } from '@/lib/matching/globalBMatching'
import { partitionByCommunity, countUnknownCommunity } from '@/lib/community/memberType'

/**
 * PROFESSIONAL SCORING — THE REGRESSION NET.
 *
 * ─── WHY THIS EXISTS, AND WHY IT SHIPPED BEFORE THE CHANGE IT GUARDS ──────────────────────────
 * Andrel Next needs the batch scorer to read a shared practice interest as a POSITIVE signal,
 * which today's expertise term deliberately does not do (it rewards partial/complementary overlap
 * and scores identical sets at zero). Changing that term is a one-line branch in the single most
 * consequential function in the product, and "Professional behaviour is unchanged" is the kind of
 * claim that is easy to assert and hard to prove.
 *
 * So it is proven, not asserted, and the proof lands in its own commit BEFORE the change. Every
 * expected value below was CAPTURED from the current implementation and frozen. They are not
 * hand-derived, and they must never be edited to make a later change pass: if a value here moves,
 * Professional scoring moved, and that is a regression to report rather than a fixture to update.
 *
 * ─── EXACT EQUALITY, NOT APPROXIMATE ──────────────────────────────────────────────────────────
 * scoreMatch returns Math.round(score), so every expectation is toBe() on an integer. There is no
 * toBeCloseTo anywhere in this file, deliberately: a change that moves a score by half a point is
 * still a change to who gets introduced to whom, because the floor and the ±10 sort band are both
 * sharp edges.
 *
 * ─── DETERMINISTIC COHORTS ────────────────────────────────────────────────────────────────────
 * Rarity is a function of cohort composition (buildRarity weights by C(d,2) sharing pairs), so a
 * fixture whose expected scores depended on accidental frequencies would be brittle in the worst
 * way — it would drift when an unrelated fixture member was added. Every cohort here is explicit:
 * the FREQ tables below state exactly how many members hold each purpose and interest, and the
 * profiles are generated from them.
 */

// ── Eligibility shape. buildScoringContext calls assertAllEligible and throws otherwise. ────────
const eligible = {
  account_status: 'active', profile_complete: true,
  is_test_account: false, is_admin: false, matching_paused: false,
}

type P = Record<string, any>

function pro(id: string, over: P = {}): P {
  return {
    id, email: `${id}@example.com`, member_type: 'professional',
    ...eligible,
    role_type: null, seniority: null, mentorship_role: null,
    interests: [], intro_preferences: [], purposes: [], expertise: '',
    subscription_tier: 'free', city: null, state: null,
    geographic_scope: 'us-wide', meeting_format_preference: 'both',
    verification_status: null, trust_score: null,
    boost_score: 0, is_priority: false,
    company: `${id} Corp`,
    ...over,
  }
}

/**
 * The signal cohort. Frequencies are stated, not incidental.
 *
 *   purposes  : 'Hiring' held by 6 of 12, 'Fundraising' by 3, 'Partnerships' by 2
 *   interests : 'Travel' held by 6 of 12, 'Music' by 3, 'Fitness' by 2
 *
 * Two members (A, B) carry every field under test; the other ten exist only to give the rarity
 * maps a stable, explicit shape.
 */
const FREQ = { purposes: { Hiring: 6, Fundraising: 3, Partnerships: 2 }, interests: { Travel: 6, Music: 3, Fitness: 2 } }

function signalCohort(aOver: P = {}, bOver: P = {}): { cohort: P[]; a: P; b: P; ctx: ScoringContext } {
  const a = pro('a', aOver)
  const b = pro('b', bOver)
  const filler: P[] = []
  // Deterministic fillers that realise FREQ exactly, counting A and B's own holdings.
  const holds = (list: string[] | undefined, k: string) => (list ?? []).includes(k)
  for (const [key, target] of Object.entries(FREQ.purposes)) {
    const already = [a, b].filter((m) => holds(m.purposes, key)).length
    for (let i = already; i < target; i++) filler.push(pro(`fp-${key}-${i}`, { purposes: [key] }))
  }
  for (const [key, target] of Object.entries(FREQ.interests)) {
    const already = [a, b].filter((m) => holds(m.interests, key)).length
    for (let i = already; i < target; i++) filler.push(pro(`fi-${key}-${i}`, { interests: [key] }))
  }
  const cohort = [a, b, ...filler]
  return { cohort, a, b, ctx: buildScoringContext(cohort, undefined, 'golden-fixture') }
}

/** Score A→B in a cohort shaped by the two members' own fields. */
function score(aOver: P, bOver: P): number {
  const { a, b, ctx } = signalCohort(aOver, bOver)
  return scoreMatch(a, b, ctx)
}

// ═══ 1. THE BASELINE ══════════════════════════════════════════════════════════════════════════
describe('1. the empty baseline every other case is measured against', () => {
  it('two blank professionals score exactly the meeting-format bonus', () => {
    // Both default to 'both' → equal → +10. Nothing else fires. This is the floor of the model.
    expect(score({}, {})).toBe(10)
  })

  it('the model is directional — scoring is not symmetric by construction', () => {
    const { a, b, ctx } = signalCohort({ intro_preferences: ['Legal'] }, { role_type: 'General Counsel' })
    expect(scoreMatch(a, b, ctx)).toBe(40)   // A's preference matches B's role → +30
    expect(scoreMatch(b, a, ctx)).toBe(30)   // reverse direction → +20
  })
})

// ═══ 2. EXPERTISE — THE TERM STEP 3.5 WILL BRANCH ═════════════════════════════════════════════
//
// Every one of these MUST be unchanged after the Next branch lands. They are the reason this file
// exists, and the four cases below are the exact boundary of `overlap > 0 && overlap < min(len)`.
describe('2. expertise complementarity — the exact current boundary', () => {
  it('IDENTICAL sets score ZERO (overlap === min → the condition is false)', () => {
    expect(score({ expertise: 'Privacy' }, { expertise: 'Privacy' })).toBe(10)
    expect(score({ expertise: 'Privacy,Litigation' }, { expertise: 'Privacy,Litigation' })).toBe(10)
  })

  it('a SUBSET scores ZERO for the same reason', () => {
    expect(score({ expertise: 'Privacy,Litigation' }, { expertise: 'Privacy' })).toBe(10)
    expect(score({ expertise: 'Privacy' }, { expertise: 'Privacy,Litigation' })).toBe(10)
  })

  it('STRICTLY PARTIAL overlap scores min(5, n) x 8', () => {
    expect(score({ expertise: 'Privacy,Litigation' }, { expertise: 'Privacy,Tax' })).toBe(18)          // 1 x 8
    expect(score({ expertise: 'Privacy,Litigation,Tax' }, { expertise: 'Privacy,Litigation,AI' })).toBe(26) // 2 x 8
  })

  it('the x8 term is capped at 5 overlapping items', () => {
    const six = 'Privacy,Litigation,Tax,AI,Risk,Finance'
    expect(score({ expertise: `${six},Legal` }, { expertise: `${six},Strategy` })).toBe(50)            // 5 x 8, not 6 x 8
  })

  it('NO overlap scores zero', () => {
    expect(score({ expertise: 'Privacy' }, { expertise: 'Litigation' })).toBe(10)
  })

  it('an EMPTY set on either side scores zero', () => {
    expect(score({ expertise: '' }, { expertise: 'Privacy' })).toBe(10)
    expect(score({ expertise: 'Privacy' }, { expertise: '' })).toBe(10)
    expect(score({ expertise: '' }, { expertise: '' })).toBe(10)
  })

  it('parses every storage shape identically (csv, json, pg-array, real array)', () => {
    for (const shape of ['Privacy,Litigation', '["Privacy","Litigation"]', '{Privacy,Litigation}', ['Privacy', 'Litigation'] as any]) {
      expect(score({ expertise: shape }, { expertise: 'Privacy,Tax' })).toBe(18)
    }
  })

  it('matching is case-insensitive on both sides', () => {
    expect(score({ expertise: 'privacy,LITIGATION' }, { expertise: 'Privacy,Tax' })).toBe(18)
  })
})

// ═══ 3. PURPOSES — RARITY-WEIGHTED OVERLAP ════════════════════════════════════════════════════
describe('3. purposes', () => {
  it('one shared COMMON purpose (6 of 12) — the rarity factor is below 1', () => {
    expect(score({ purposes: ['Hiring'] }, { purposes: ['Hiring'] })).toBe(21)
  })

  it('one shared RARER purpose (2 of 12) scores higher than a common one', () => {
    expect(score({ purposes: ['Partnerships'] }, { purposes: ['Partnerships'] })).toBe(28)
  })

  it('two shared purposes apply the geometric decay, rarest first', () => {
    expect(score({ purposes: ['Hiring', 'Partnerships'] }, { purposes: ['Hiring', 'Partnerships'] })).toBe(37)
  })

  it('no shared purpose scores zero', () => {
    expect(score({ purposes: ['Hiring'] }, { purposes: ['Fundraising'] })).toBe(10)
  })
})

// ═══ 4. INTERESTS ═════════════════════════════════════════════════════════════════════════════
describe('4. interests', () => {
  it('one shared COMMON interest (6 of 12)', () => {
    expect(score({ interests: ['Travel'] }, { interests: ['Travel'] })).toBe(19)
  })

  it('one shared RARER interest (2 of 12)', () => {
    expect(score({ interests: ['Fitness'] }, { interests: ['Fitness'] })).toBe(25)
  })

  it('three shared interests decay geometrically', () => {
    const three = ['Travel', 'Music', 'Fitness']
    expect(score({ interests: three }, { interests: three })).toBe(42)
  })
})

// ═══ 5. GEOGRAPHY — ALL FOUR BRANCHES ═════════════════════════════════════════════════════════
describe('5. geography', () => {
  it("scope 'local' + same city → +15", () => {
    expect(score({ city: 'Boston', state: 'MA', geographic_scope: 'local' }, { city: 'Boston', state: 'MA' })).toBe(25)
  })

  it("scope 'local' + same state only → +15", () => {
    expect(score({ city: 'Boston', state: 'MA', geographic_scope: 'local' }, { city: 'Worcester', state: 'MA' })).toBe(25)
  })

  it('same city under the default scope → +8', () => {
    expect(score({ city: 'Boston', state: 'MA' }, { city: 'Boston', state: 'MA' })).toBe(18)
  })

  it('same state only under the default scope → +5', () => {
    expect(score({ city: 'Boston', state: 'MA' }, { city: 'Worcester', state: 'MA' })).toBe(15)
  })

  it('neither → 0', () => {
    expect(score({ city: 'Boston', state: 'MA' }, { city: 'Austin', state: 'TX' })).toBe(10)
  })

  it('the scope read is the RECIPIENT\'s, not the candidate\'s', () => {
    expect(score({ city: 'Boston', state: 'MA' }, { city: 'Boston', state: 'MA', geographic_scope: 'local' })).toBe(18)
  })

  it('a null city on either side never matches', () => {
    expect(score({ city: null, state: null }, { city: null, state: null })).toBe(10)
  })
})

// ═══ 6. MEETING FORMAT — ALL THREE BRANCHES ═══════════════════════════════════════════════════
describe('6. meeting format', () => {
  it('equal → +10', () => {
    expect(score({ meeting_format_preference: 'virtual' }, { meeting_format_preference: 'virtual' })).toBe(10)
  })

  it("one side 'both' → +5", () => {
    expect(score({ meeting_format_preference: 'both' }, { meeting_format_preference: 'in_person' })).toBe(5)
  })

  it('different and neither is both → 0', () => {
    expect(score({ meeting_format_preference: 'virtual' }, { meeting_format_preference: 'in_person' })).toBe(0)
  })

  it('null defaults to both on both sides → +10', () => {
    expect(score({ meeting_format_preference: null }, { meeting_format_preference: null })).toBe(10)
  })
})

// ═══ 7. SENIORITY — ALL FOUR BRANCHES ═════════════════════════════════════════════════════════
describe('7. seniority', () => {
  it('junior recipient + senior candidate → +12', () => {
    expect(score({ seniority: 'Junior' }, { seniority: 'Senior' })).toBe(22)
  })

  it('senior recipient + junior candidate → +8', () => {
    expect(score({ seniority: 'Executive' }, { seniority: 'Junior' })).toBe(18)
  })

  it('equal and non-empty → +5', () => {
    expect(score({ seniority: 'Senior' }, { seniority: 'Senior' })).toBe(15)
  })

  it('BOTH NULL → 0, because the equality branch requires a truthy value', () => {
    // Load-bearing for Andrel Next, where seniority stays NULL: this term must contribute nothing.
    expect(score({ seniority: null }, { seniority: null })).toBe(10)
    expect(score({ seniority: '' }, { seniority: '' })).toBe(10)
  })
})

// ═══ 8. INTRO PREFERENCES / ROLE ══════════════════════════════════════════════════════════════
describe('8. intro preferences resolve through the role taxonomy', () => {
  it('a category preference matches a role in that category → +30', () => {
    expect(score({ intro_preferences: ['Legal'] }, { role_type: 'General Counsel' })).toBe(40)
  })

  it('an unmatched category scores zero', () => {
    expect(score({ intro_preferences: ['Finance'] }, { role_type: 'General Counsel' })).toBe(10)
  })

  it('an EMPTY candidate role can never match — the guard is `if (!p || !r) return false`', () => {
    // The property Andrel Next depends on: a role-less member contributes nothing here, and cannot
    // accidentally satisfy every preference.
    expect(score({ intro_preferences: ['Legal'] }, { role_type: null })).toBe(10)
    expect(score({ intro_preferences: ['Legal'] }, { role_type: '' })).toBe(10)
  })

  it('an empty preference list scores zero', () => {
    expect(score({ intro_preferences: [] }, { role_type: 'General Counsel' })).toBe(10)
  })
})

// ═══ 9. CANDIDATE-QUALITY AMPLIFIERS ══════════════════════════════════════════════════════════
describe('9. tier, verification, trust and the promotion levers', () => {
  it.each([['executive', 25], ['professional', 18], ['free', 10], ['unknown-tier', 10]])(
    'tier %s → %i', (tier, expected) => {
      expect(score({}, { subscription_tier: tier })).toBe(expected)
    })

  it.each([['verified', 25], ['high_confidence', 22], ['pending', 10], ['flagged', -10]])(
    'verification %s → %i', (status, expected) => {
      expect(score({}, { verification_status: status })).toBe(expected)
    })

  it('a NULL verification status contributes nothing', () => {
    expect(score({}, { verification_status: null })).toBe(10)
  })

  it('trust_score is scaled to 10 points', () => {
    expect(score({}, { trust_score: 100 })).toBe(20)
    expect(score({}, { trust_score: 50 })).toBe(15)
    expect(score({}, { trust_score: 0 })).toBe(10)
  })

  it('boost_score and is_priority apply to the CANDIDATE only', () => {
    expect(score({}, { boost_score: 10 })).toBe(30)        // x2
    expect(score({}, { is_priority: true })).toBe(60)      // +50
    expect(score({ boost_score: 10, is_priority: true }, {})).toBe(10)
  })

  it('mentorship_role pairs mentor with mentee, both directions', () => {
    expect(score({ mentorship_role: 'Mentor' }, { mentorship_role: 'Mentee' })).toBe(35)
    expect(score({ mentorship_role: 'Mentee' }, { mentorship_role: 'Mentor' })).toBe(35)
    expect(score({ mentorship_role: 'Mentor' }, { mentorship_role: 'Mentor' })).toBe(10)
  })
})

// ═══ 10. A FULLY-LOADED PAIR ══════════════════════════════════════════════════════════════════
describe('10. every signal at once', () => {
  it('a maximal professional pair scores exactly this', () => {
    const a = {
      intro_preferences: ['Legal'], purposes: ['Hiring', 'Partnerships'],
      interests: ['Travel', 'Music'], expertise: 'Privacy,Litigation',
      city: 'Boston', state: 'MA', geographic_scope: 'local',
      seniority: 'Junior', role_type: 'General Counsel',
    }
    const b = {
      intro_preferences: ['Legal'], purposes: ['Hiring', 'Partnerships'],
      interests: ['Travel', 'Music'], expertise: 'Privacy,Tax',
      city: 'Boston', state: 'MA',
      seniority: 'Senior', role_type: 'General Counsel',
      subscription_tier: 'executive', verification_status: 'verified', trust_score: 80,
    }
    expect(score(a, b)).toBe(182)
  })
})

// ═══ 11. WHOLE-POOL DETERMINISM ═══════════════════════════════════════════════════════════════
//
// WHAT THIS COVERS, STATED HONESTLY. computeCohortSuggestions is a closure inside
// app/api/admin/generate-batch/route.ts, over roughly fifteen outer variables (hiddenMap, passMap,
// visibleCards, capacityByMember, …). It cannot be imported, and extracting it would be a source
// change — which must not live in the regression-net commit.
//
// So this fixture reproduces the route's DETERMINISTIC PIPELINE from the same exported pieces the
// route uses — buildScoringContext, scoreMatch, the route's exact comparator, the route's floor,
// solveGlobalBMatching — and pins every intermediate value. It covers scoring, the floor, the
// histogram, the ordering and the selected pairs: every stage Step 3.5 touches.
//
// It does NOT cover the route's exclusion maps or its two-pass legal wiring. Those are unchanged by
// Step 3.5 and are guarded by the existing batch suites. A structural pin below asserts the route
// still uses this pipeline, so the fixture cannot silently diverge from what it claims to model.
describe('11. the whole Professional pool is deterministic end to end', () => {
  const POOL: P[] = [
    pro('p1', { purposes: ['Hiring'], interests: ['Travel'], expertise: 'Privacy,Litigation', city: 'Boston', state: 'MA', seniority: 'Senior', subscription_tier: 'professional' }),
    pro('p2', { purposes: ['Hiring', 'Partnerships'], interests: ['Travel', 'Music'], expertise: 'Privacy,Tax', city: 'Boston', state: 'MA', seniority: 'Junior' }),
    pro('p3', { purposes: ['Fundraising'], interests: ['Music'], expertise: 'Litigation,AI', city: 'Austin', state: 'TX', seniority: 'Executive' }),
    pro('p4', { purposes: ['Hiring'], interests: ['Fitness'], expertise: 'Tax', city: 'Austin', state: 'TX', seniority: 'Senior' }),
    pro('p5', { purposes: ['Partnerships'], interests: ['Travel'], expertise: 'AI,Risk', city: 'Boston', state: 'MA', seniority: 'Junior' }),
    pro('p6', { purposes: ['Fundraising', 'Hiring'], interests: ['Music', 'Fitness'], expertise: 'Privacy,AI', city: 'Denver', state: 'CO', seniority: 'Senior' }),
  ]

  /** The route's comparator, verbatim (generate-batch/route.ts). */
  const routeComparator = (a: any, b: any) =>
    Math.abs(a.relevanceScore - b.relevanceScore) > 10
      ? b.relevanceScore - a.relevanceScore
      : b.mutualScore - a.mutualScore

  function runPool(cohort: P[], floor: number) {
    const ctx = buildScoringContext(cohort, undefined, 'golden-pool')
    const histogram: Record<string, number> = { '0-19': 0, '20-29': 0, '30-34': 0, '35-39': 0, '40-49': 0, '50-69': 0, '70+': 0 }
    const bucketOf = (v: number) =>
      v < 20 ? '0-19' : v < 30 ? '20-29' : v < 35 ? '30-34' : v < 40 ? '35-39' : v < 50 ? '40-49' : v < 70 ? '50-69' : '70+'
    const allPairs: any[] = []
    let cut = 0, considered = 0
    for (let i = 0; i < cohort.length; i++) {
      for (let j = i + 1; j < cohort.length; j++) {
        const A = cohort[i], B = cohort[j]
        const scoreAtoB = scoreMatch(A, B, ctx)
        const scoreBtoA = scoreMatch(B, A, ctx)
        const avg = (scoreAtoB + scoreBtoA) / 2
        considered++
        histogram[bucketOf(avg)]++
        if (avg < floor) { cut++; continue }
        allPairs.push({ userA: A, userB: B, scoreAtoB, scoreBtoA, mutualScore: scoreAtoB + scoreBtoA, relevanceScore: avg })
      }
    }
    allPairs.sort(routeComparator)
    const capacityByMember = new Map(cohort.map((p) => [p.id, 2]))
    const existingVisibleByMember = new Map(cohort.map((p) => [p.id, 0]))
    const solved = solveGlobalBMatching(allPairs as any[], { capacityByMember, existingVisibleByMember })
    return { considered, cut, histogram, allPairs, selected: solved.selected, exact: solved.exact }
  }

  const run = runPool(POOL, BATCH_CONFIG.minRelevanceScore)

  it('every directional score, mutual and relevance value is pinned', () => {
    expect(run.allPairs.map((p) => [`${p.userA.id}-${p.userB.id}`, p.scoreAtoB, p.scoreBtoA, p.mutualScore, p.relevanceScore]))
      .toEqual([
        ['p1-p2', 52, 64, 116, 58],
        ['p2-p5', 54, 54, 108, 54],
        ['p3-p6', 49, 49, 98, 49],
        ['p2-p6', 48, 44, 92, 46],
        ['p1-p5', 35, 47, 82, 41],
      ])
  })

  it('pair ORDERING after the route comparator is pinned', () => {
    expect(run.allPairs.map((p) => `${p.userA.id}-${p.userB.id}`)).toEqual(['p1-p2', 'p2-p5', 'p3-p6', 'p2-p6', 'p1-p5'])
  })

  it('the floor cut count and the full histogram are pinned', () => {
    expect(run.considered).toBe(15)
    expect(run.cut).toBe(10)
    expect(run.histogram).toEqual({ '0-19': 1, '20-29': 7, '30-34': 0, '35-39': 2, '40-49': 3, '50-69': 2, '70+': 0 })
  })

  it('the selected (recipient, suggested) pairs are pinned', () => {
    expect(run.selected.map((e: any) => [e.userA.id, e.userB.id])).toEqual([['p1', 'p2'], ['p1', 'p5'], ['p2', 'p5'], ['p3', 'p6']])
    expect(run.exact).toBe(true)
  })

  it('the route still uses this pipeline — the fixture cannot silently diverge', () => {
    const route = readFileSync('app/api/admin/generate-batch/route.ts', 'utf8')
    expect(route).toMatch(/const scoringCtx: ScoringContext = buildScoringContext\(cohort, undefined, 'generate-batch'\)/)
    expect(route).toMatch(/const avgScore = \(scoreAtoB \+ scoreBtoA\) \/ 2/)
    expect(route).toMatch(/if \(avgScore < MIN_RELEVANCE_SCORE\) \{ pairsCutByScoreFloor\+\+; continue \}/)
    expect(route).toMatch(/Math\.abs\(a\.relevanceScore - b\.relevanceScore\) > 10/)
    expect(route).toMatch(/solveGlobalBMatching\(primaryPairs as any\[\], baseSolverConfig\)/)
  })
})

// ═══ 12. PARTITION INVARIANCE ═════════════════════════════════════════════════════════════════
describe('12. a database with zero Next members behaves exactly as it does today', () => {
  const PROFESSIONALS = [pro('x1', { purposes: ['Hiring'] }), pro('x2', { purposes: ['Hiring'] }), pro('x3', {})]

  it('the Professional partition is the input array, element for element', () => {
    const parts = partitionByCommunity(PROFESSIONALS)
    expect(parts.get('professional')).toEqual(PROFESSIONALS)
    expect(parts.get('next')).toEqual([])
    expect(countUnknownCommunity(PROFESSIONALS)).toBe(0)
  })

  it('adding Next members does not change the Professional partition or its scores', () => {
    const next = [
      { ...pro('n1'), member_type: 'next', purposes: ['Explore practice areas'], expertise: 'Privacy' },
      { ...pro('n2'), member_type: 'next', purposes: ['Explore practice areas'], expertise: 'Privacy' },
    ]
    const mixed = [...PROFESSIONALS, ...next]
    expect(partitionByCommunity(mixed).get('professional')).toEqual(PROFESSIONALS)

    // ...and the Professional cohort's own scores are identical, because the context is built from
    // the partition rather than the mixed pool — the property migration-era Stage 2B introduced.
    const alone = buildScoringContext(PROFESSIONALS, undefined, 'inv-a')
    const fromMixed = buildScoringContext(partitionByCommunity(mixed).get('professional')!, undefined, 'inv-b')
    expect(scoreMatch(PROFESSIONALS[0], PROFESSIONALS[1], fromMixed))
      .toBe(scoreMatch(PROFESSIONALS[0], PROFESSIONALS[1], alone))
  })

  it('a member with an unrecognised community enters NEITHER partition', () => {
    const odd = [...PROFESSIONALS, { ...pro('u1'), member_type: 'student' }]
    const parts = partitionByCommunity(odd)
    expect(parts.get('professional')).toEqual(PROFESSIONALS)
    expect(parts.get('next')).toEqual([])
    expect(countUnknownCommunity(odd)).toBe(1)
  })
})

// ═══ 13. THE CONFIG SNAPSHOT AS IT STANDS TODAY ═══════════════════════════════════════════════
describe('13. the pre-change algorithm configuration', () => {
  it('the Professional floor is 40', () => {
    expect(BATCH_CONFIG.minRelevanceScore).toBe(40)
  })

  it('the scoring config is exactly this', () => {
    expect(SCORING_CONFIG).toEqual({
      purposeBase: 12, purposeDecay: 0.75,
      interestBase: 10, interestDecay: 0.75,
      rarityClampMin: 0.25, rarityClampMax: 2.5,
      boostMultiplier: 2, priorityBonus: 50,
    })
  })

  it('the snapshot carries the three config objects', () => {
    const snap = algorithmSnapshot() as any
    expect(Object.keys(snap).sort()).toEqual(['batch', 'exposure', 'scoring', 'scoringModelVersion', 'version'])
  })

  it('the config hash BEFORE Step 3.5 is pinned', () => {
    // Recorded so the Step 3.5 hash change is a visible, reviewed delta rather than a silent one.
    // This value is the PRE-3.5 hash and is expected to change when Next constants join the
    // snapshot. When it does, the change is deliberate and the new value is pinned alongside it.
    expect(algorithmConfigHash()).toBe('df26f0c8')
  })
})

// ═══ 14. HELPERS THE FIXTURES DEPEND ON ═══════════════════════════════════════════════════════
describe('14. the shared overlap machinery', () => {
  it('overlapScore is base x rarity with geometric decay, rarest first', () => {
    const rarity = new Map([['a', 2], ['b', 1]])
    expect(overlapScore(['b', 'a'], rarity, 10, 0.75)).toBe(10 * (2 + 0.75 * 1))
    expect(overlapScore([], rarity, 10, 0.75)).toBe(0)
  })

  it('an item with no rarity entry defaults to a factor of 1', () => {
    expect(overlapScore(['zzz'], new Map(), 10, 0.75)).toBe(10)
  })

  it('parseList handles every stored shape', () => {
    expect(parseList('a,b')).toEqual(['a', 'b'])
    expect(parseList('["a","b"]')).toEqual(['a', 'b'])
    expect(parseList('{a,b}')).toEqual(['a', 'b'])
    expect(parseList(['a', 'b'])).toEqual(['a', 'b'])
    expect(parseList(null)).toEqual([])
    expect(parseList('{}')).toEqual([])
  })
})
