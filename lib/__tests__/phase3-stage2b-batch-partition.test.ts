import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildScoringContext, scoreMatch } from '@/lib/matching/batch-scoring'
import { solveGlobalBMatching } from '@/lib/matching/globalBMatching'
import { partitionByCommunity } from '@/lib/community/memberType'

/**
 * PHASE 3 STAGE 2B, COMMIT 3 — the admin batch computes each community in isolation.
 *
 * The claim under test is NOT "no cross-community suggestion is written". Stage 1 already
 * guarantees that at the database. The claim is that one community cannot INFLUENCE the other's
 * results, through either channel the audit found:
 *
 *   IDF     buildScoringContext takes memberCount from the cohort, and
 *           idf(df) = log((N+1)/(df+1)) / log(N+1). N is cohort size.
 *   SOLVER  reduceComponent keeps each member's top-k edges and HALVES k until a component fits
 *           MAX_COMPONENT_EDGES. A mixed cohort is one bigger component, so Professionals get a
 *           harsher reduction — degraded matches with no cross-community pair in the output.
 *
 * So the tests below add hundreds of Next members and assert the Professional numbers do not move.
 */

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────
const member = (id: string, member_type: unknown, over: Record<string, unknown> = {}) => ({
  id,
  member_type,
  full_name: `M ${id}`,
  email: `${id}@x.com`,
  role_type: 'Founder',
  seniority: 'senior',
  interests: ['tech', 'travel', 'music'],
  intro_preferences: ['Founder'],
  subscription_tier: 'free',
  looking_for: '',
  expertise: ['ai', 'saas'],
  networkValueScore: 80,
  responsivenessScore: 80,
  verification_status: 'verified',
  trust_score: 90,
  purposes: ['raise capital', 'hire'],
  city: 'NYC',
  state: 'NY',
  geographic_scope: 'us-wide',
  meeting_format_preference: 'both',
  open_to_business_solutions: false,
  boost_score: 0,
  is_priority: false,
  profile_complete: true,
  account_status: 'active',
  is_test_account: false,
  is_admin: false,
  matching_paused: false,
  company: `Co ${id}`,
  ...over,
})

const PRO = (id: string, over = {}) => member(id, 'professional', over)
const NEXT = (id: string, over = {}) => member(id, 'next', over)

/** The generator's pair loop + solver call, reproduced faithfully enough to observe isolation. */
const pairsFor = (cohort: any[], ctx: ReturnType<typeof buildScoringContext>) => {
  const out: any[] = []
  for (let i = 0; i < cohort.length; i++) {
    for (let j = i + 1; j < cohort.length; j++) {
      const a = cohort[i], b = cohort[j]
      out.push({
        userA: a, userB: b,
        scoreAtoB: scoreMatch(a, b, ctx),
        scoreBtoA: scoreMatch(b, a, ctx),
      })
    }
  }
  return out
}
const solve = (cohort: any[], edges: any[]) =>
  solveGlobalBMatching(edges as any[], {
    capacityByMember: new Map(cohort.map((p) => [p.id, 2])),
    existingVisibleByMember: new Map(cohort.map((p) => [p.id, 0])),
  } as any)

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('Professional-only: the partition changes nothing', () => {
  const cohort = Array.from({ length: 12 }, (_, i) => PRO(`p${i}`))

  it('the Professional partition is the eligible array, object for object', () => {
    const pro = partitionByCommunity(cohort).get('professional')!
    expect(pro).toEqual(cohort)
    pro.forEach((p, i) => expect(p).toBe(cohort[i]))
  })

  it('ScoringContext and memberCount are identical to the un-partitioned build', () => {
    const before = buildScoringContext(cohort, undefined, 'test')
    const after = buildScoringContext(partitionByCommunity(cohort).get('professional')!, undefined, 'test')
    expect(after.memberCount).toBe(before.memberCount)
    expect(after.memberCount).toBe(12)
    expect(Array.from(after.purposeRarity.entries())).toEqual(Array.from(before.purposeRarity.entries()))
    expect(Array.from(after.interestRarity.entries())).toEqual(Array.from(before.interestRarity.entries()))
  })

  it('every pair score is identical', () => {
    const before = pairsFor(cohort, buildScoringContext(cohort, undefined, 'test'))
    const pro = partitionByCommunity(cohort).get('professional')!
    const after = pairsFor(pro, buildScoringContext(pro, undefined, 'test'))
    expect(after.map((e) => [e.userA.id, e.userB.id, e.scoreAtoB, e.scoreBtoA]))
      .toEqual(before.map((e) => [e.userA.id, e.userB.id, e.scoreAtoB, e.scoreBtoA]))
  })

  it('solver inputs AND selected edges are identical, in the same order', () => {
    const beforeEdges = pairsFor(cohort, buildScoringContext(cohort, undefined, 'test'))
    const pro = partitionByCommunity(cohort).get('professional')!
    const afterEdges = pairsFor(pro, buildScoringContext(pro, undefined, 'test'))
    const b = solve(cohort, beforeEdges)
    const a = solve(pro, afterEdges)
    const ids = (r: any) => r.selected.map((e: any) => `${e.userA.id}|${e.userB.id}`)
    expect(ids(a)).toEqual(ids(b))
    expect(a.exact).toBe(b.exact)
    expect(a.nodesExplored).toBe(b.nodesExplored)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('Mixed cohort: two independent computations', () => {
  const pros = Array.from({ length: 10 }, (_, i) => PRO(`p${i}`))
  const nexts = Array.from({ length: 6 }, (_, i) => NEXT(`n${i}`, { purposes: ['clerkship'], interests: ['moot court'] }))
  const mixed = [...pros.slice(0, 5), ...nexts, ...pros.slice(5)]

  it('produces two contexts, each counting only its own community', () => {
    const m = partitionByCommunity(mixed)
    const proCtx = buildScoringContext(m.get('professional')!, undefined, 'test')
    const nextCtx = buildScoringContext(m.get('next')!, undefined, 'test')
    expect(proCtx.memberCount).toBe(10)   // excludes Next
    expect(nextCtx.memberCount).toBe(6)   // excludes Professional
    expect(proCtx.memberCount + nextCtx.memberCount).toBe(mixed.length)
  })

  it('the rejected shape is measurably different — proving the partition is load-bearing', () => {
    // buildScoringContext(16) is NOT buildScoringContext(10). If someone "fixed" this by scoring
    // everyone and dropping cross edges afterwards, Professional scores would move. This test is
    // what makes that visible rather than theoretical.
    const combined = buildScoringContext(mixed, undefined, 'test')
    const proOnly = buildScoringContext(partitionByCommunity(mixed).get('professional')!, undefined, 'test')
    expect(combined.memberCount).not.toBe(proOnly.memberCount)
    const a = pairsFor(pros, proOnly)
    const b = pairsFor(pros, combined)
    expect(a.map((e) => e.scoreAtoB)).not.toEqual(b.map((e) => e.scoreAtoB))
  })

  it('no cross-community pair is ever scored, and none reaches the solver', () => {
    const m = partitionByCommunity(mixed)
    for (const community of ['professional', 'next'] as const) {
      const cohort = m.get(community)!
      const edges = pairsFor(cohort, buildScoringContext(cohort, undefined, 'test'))
      for (const e of edges) {
        expect(e.userA.member_type).toBe(community)
        expect(e.userB.member_type).toBe(community)
      }
      for (const e of solve(cohort, edges).selected as any[]) {
        expect(e.userA.member_type).toBe(community)
        expect(e.userB.member_type).toBe(community)
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('Isolation under scale — both contamination channels', () => {
  const pros = Array.from({ length: 14 }, (_, i) => PRO(`p${i}`))

  const professionalResult = (extraNext: number) => {
    const cohort = [...pros, ...Array.from({ length: extraNext }, (_, i) => NEXT(`n${i}`))]
    const pro = partitionByCommunity(cohort).get('professional')!
    const ctx = buildScoringContext(pro, undefined, 'test')
    const edges = pairsFor(pro, ctx)
    const r = solve(pro, edges)
    return {
      memberCount: ctx.memberCount,
      scores: edges.map((e) => [e.scoreAtoB, e.scoreBtoA]),
      selected: r.selected.map((e: any) => `${e.userA.id}|${e.userB.id}`),
      exact: r.exact,
      nodes: r.nodesExplored,
    }
  }

  it('Professional output is invariant to 0, 10 and 500 Next members', () => {
    const base = professionalResult(0)
    for (const n of [10, 500]) {
      const with_ = professionalResult(n)
      expect(with_.memberCount, `${n} Next`).toBe(base.memberCount)
      expect(with_.scores, `${n} Next`).toEqual(base.scores)
      expect(with_.selected, `${n} Next`).toEqual(base.selected)
      expect(with_.exact, `${n} Next`).toBe(base.exact)
      // reduceComponent halves top-k by COMPONENT SIZE. Identical node counts prove the
      // Professional component never grew — the second contamination channel is closed.
      expect(with_.nodes, `${n} Next`).toBe(base.nodes)
    }
  })

  it('Next output is invariant to the number of Professionals (symmetric)', () => {
    const nexts = Array.from({ length: 8 }, (_, i) => NEXT(`n${i}`))
    const run = (extraPro: number) => {
      const cohort = [...nexts, ...Array.from({ length: extraPro }, (_, i) => PRO(`x${i}`))]
      const nx = partitionByCommunity(cohort).get('next')!
      const ctx = buildScoringContext(nx, undefined, 'test')
      const edges = pairsFor(nx, ctx)
      return { memberCount: ctx.memberCount, selected: solve(nx, edges).selected.map((e: any) => `${e.userA.id}|${e.userB.id}`) }
    }
    const base = run(0)
    for (const n of [10, 500]) {
      expect(run(n).memberCount, `${n} Pro`).toBe(base.memberCount)
      expect(run(n).selected, `${n} Pro`).toEqual(base.selected)
    }
  })

  it('a member with an unrecognised community affects neither context', () => {
    const cohort = [...pros, member('u1', null), member('u2', 'student'), member('u3', 'Professional')]
    const m = partitionByCommunity(cohort)
    expect(buildScoringContext(m.get('professional')!, undefined, 'test').memberCount).toBe(14)
    expect(m.get('next')).toEqual([])
    const ids = [...m.get('professional')!, ...m.get('next')!].map((p: any) => p.id)
    for (const u of ['u1', 'u2', 'u3']) expect(ids).not.toContain(u)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('The route wires it the way the design requires', () => {
  const SRC = readFileSync('app/api/admin/generate-batch/route.ts', 'utf8')
  const codeOnly = SRC.split('\n').filter((l) => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')
  const FN = codeOnly.slice(
    codeOnly.indexOf('const computeCohortSuggestions = (cohort: any[]) => {'),
    codeOnly.indexOf('const partitions = partitionByCommunity'),
  )

  it('partitionByCommunity has exactly one production caller: this route', () => {
    const { execSync } = require('node:child_process')
    const callers = execSync("grep -rln 'partitionByCommunity' --include='*.ts' app lib || true", { encoding: 'utf8' })
      .split('\n').filter(Boolean)
      .filter((f: string) => !f.includes('__tests__') && f !== 'lib/community/memberType.ts')
    expect(callers).toEqual(['app/api/admin/generate-batch/route.ts'])
  })

  it('the scoring context is built from the cohort, and no combined-cohort context exists', () => {
    expect(FN).toContain("buildScoringContext(cohort, undefined, 'generate-batch')")
    // The rejected shape would need a context over the full profile array. There is none.
    expect(codeOnly).not.toMatch(/buildScoringContext\(\s*profiles/)
    expect(codeOnly.match(/buildScoringContext\(/g)).toHaveLength(1)
  })

  it('scoring, both solves and the pair loop are all INSIDE the per-cohort function', () => {
    for (const stage of ['scoreMatchV2(', 'allPairs.sort(', 'solveGlobalBMatching(',
                         'const fallbackPairs', 'const userBatches']) {
      expect(FN, stage).toContain(stage)
    }
    // Two solver calls, both inside — primary and fallback cannot recombine communities.
    expect(FN.match(/solveGlobalBMatching\(/g)).toHaveLength(2)
    expect(codeOnly.match(/solveGlobalBMatching\(/g)).toHaveLength(2)
  })

  it('the post-solve cohort-boundary invariant is executable, not a comment', () => {
    expect(FN).toContain('const cohortIds = new Set(cohort.map((p: any) => p.id))')
    expect(FN).toMatch(/if \(!cohortIds\.has\(e\.userA\.id\) \|\| !cohortIds\.has\(e\.userB\.id\)\)/)
    expect(FN).toContain("throw new Error('generate-batch: selected edge crosses the cohort boundary')")
  })

  it('cohorts run Professional first, and a cohort under 2 members is skipped silently', () => {
    expect(codeOnly).toContain('const cohortResults = MEMBER_TYPES')
    expect(codeOnly).toMatch(/\.filter\(\(cohort\) => cohort\.length >= 2\)/)
    // No throw, no special status, for a small community.
    expect(codeOnly).not.toMatch(/cohort\.length < 2[\s\S]{0,120}(throw|status: 4|status: 5)/)
  })

  it('exactly ONE introduction_batches row and ONE batch_suggestions insert remain', () => {
    expect(codeOnly.match(/from\('introduction_batches'\)\.insert\(/g)).toHaveLength(2) // versioned + fallback retry
    expect(codeOnly.match(/from\('batch_suggestions'\)\.insert\(/g)).toHaveLength(1)
    expect(codeOnly).toContain('for (const row of allSuggestions) row.batch_id = batch.id')
  })

  it('metrics use the recognised member total, not the raw profile count', () => {
    expect(codeOnly).toContain('usersMatched: recognisedMembers,')
    expect(codeOnly).toContain('allSuggestions.length / recognisedMembers')
    expect(codeOnly).toContain('membersSkippedUnknownCommunity,')
    expect(codeOnly).not.toMatch(/usersMatched: profiles\.length/)
  })

  it('nothing that decides matching was touched', () => {
    // Constants, comparator and solver config must be exactly as they were.
    expect(SRC).toContain('const MIN_RELEVANCE_SCORE = BATCH_CONFIG.minRelevanceScore')
    expect(SRC).toContain('const MAX_SAME_ROLE_PERCENT = BATCH_CONFIG.maxSameRolePercent')
    expect(SRC).toMatch(/if \(Math\.abs\(a\.relevanceScore - b\.relevanceScore\) > 10\)/)
    expect(SRC).toMatch(/return b\.mutualScore - a\.mutualScore/)
    expect(SRC).toContain('const primaryPairs = allPairs.filter((e) => !isSameSideLegalPair(e.userA, e.userB))')
  })

  it('no Andrel Next mentorship or recruiting/hiring exception exists in ordinary generation', () => {
    // Targets the ANDREL NEXT bridge columns specifically. `mentorship_role` is deliberately NOT
    // matched: it is the pre-existing Professional mentorship preference, in this select long
    // before Phase 3, and migration 095's tests already pin that its semantics are neither reused
    // nor altered by the community work. Matching it would fail on unrelated existing behaviour.
    expect(codeOnly).not.toMatch(/open_to_next_mentorship|seeking_next_mentorship|grad_year/)
    expect(codeOnly).not.toMatch(/recruit|hiring_bridge|\bbridge\b|crossCommunity|allowCross/i)
    // And the ordinary batch stays same-community by construction: the only community rule it uses
    // is the shared partition helper, with no exception argument of any kind.
    expect(codeOnly.match(/partitionByCommunity\(/g)).toHaveLength(1)
    expect(codeOnly).toMatch(/partitionByCommunity\(profiles as any\[\]\)/)
  })
})
