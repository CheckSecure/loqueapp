import { describe, it, expect } from 'vitest'
import {
  buildScoringContext,
  scoreMatch,
  effectiveTierDistribution,
  algorithmConfigHash,
  RECOMMENDATION_ALGORITHM_VERSION,
  SCORING_MODEL_VERSION,
} from '@/lib/matching/batch-scoring'
import { solveGlobalBMatching, crossMarketAdjustment, nullSafeRole } from '@/lib/matching/globalBMatching'
import { isSameSideLegalPair, lawFirmRole } from '@/lib/matching/legalSameSidePenalty'
import { isSameCompany } from '@/lib/matching/same-company'
import { isBusinessSolutionProvider, maxBusinessSolutionCount, isLegalNetworkingPair } from '@/lib/matching/business-solutions'
import { perRecipientIntroLimit } from '@/lib/matching/batch-limits'
import { visibleDeficit } from '@/lib/matching/generationInvariants'
import { MAX_VISIBLE_INTRO_CARDS } from '@/lib/introductions/capacity'

/**
 * PROFESSIONAL GOLDEN-OUTPUT BASELINE — captured at c3bd749, BEFORE Phase 3 changed anything.
 *
 * ─── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 * Community scoping fails QUIETLY. If Phase 3 accidentally narrows the Professional candidate pool
 * or perturbs a score, nobody sees an error — members just get fewer or different introductions,
 * which is indistinguishable from a slow week. Every other Phase 3 test proves that a cross-community
 * pair is REFUSED; this one is the only test that proves Professional members still get exactly the
 * introductions they got before.
 *
 * ─── WHY THIS SURFACE ─────────────────────────────────────────────────────────────────────────
 * It pins the deterministic core of the admin batch generator (app/api/admin/generate-batch):
 * buildScoringContext -> the hard pair gates -> scoreMatch -> solveGlobalBMatching. Verified
 * deterministic: batch-scoring.ts and globalBMatching.ts contain zero Math.random calls.
 * lib/generate-recommendations.ts is deliberately NOT pinned here — it calls Math.random in ten
 * places (tier ranking jitter), so a golden assertion over it would be flaky and would have to be
 * loosened until it proved nothing.
 *
 * ─── THE RULE FOR WHOEVER TOUCHES THIS FILE NEXT ──────────────────────────────────────────────
 * The expected values below were produced by the CURRENT (pre-Phase-3) code and reviewed as correct
 * for a Professional-only network. If an implementation change makes this file fail, the change is
 * wrong until proven otherwise — DO NOT regenerate the expectations to match new output. That is
 * the single failure mode this file exists to prevent.
 */

// ── A deterministic Professional-only fixture ────────────────────────────────────────────────
// Ten members spanning the role/seniority/geography/expertise combinations the scorer actually
// branches on: in-house vs law-firm (the cross-market preference), two same-firm colleagues (the
// same-company gate), a law-firm partner pair (the same-side legal gate), a business-solution
// provider (the provider quota), and mixed tiers (per-recipient caps).
const M = (
  id: string, role_type: string, seniority: string, company: string,
  expertise: string[], purposes: string[], interests: string[],
  city: string, state: string, tier: string,
) => ({
  id, role_type, seniority, company,
  expertise: JSON.stringify(expertise),
  purposes, interests,
  city, state, location: `${city}, ${state}`,
  subscription_tier: tier,
  geographic_scope: 'us-wide',
  meeting_format_preference: 'both',
  open_to_business_solutions: false,
  intro_preferences: [] as string[],
  full_name: id,
  networkValueScore: 50,
  responsivenessScore: 50,
  trust_score: 50,
  boost_score: 0,
  is_priority: false,
  account_status: 'active',
  profile_complete: true,
  is_test_account: false,
  is_admin: false,
  matching_paused: false,
  email: `${id}@example.com`,
})

const FIXTURE = [
  M('p01', 'In-house Counsel',  'Senior',    'Acme Corp',     ['Privacy', 'Data Protection'], ['Learn & grow'],   ['Technology'], 'New York', 'NY', 'professional'),
  M('p02', 'Law firm attorney', 'Senior',    'Skadden',       ['Privacy', 'M&A'],             ['Expand network'], ['Technology'], 'New York', 'NY', 'professional'),
  M('p03', 'In-house Counsel',  'Executive', 'Globex',        ['M&A', 'Securities'],          ['Hire talent'],    ['Travel'],     'Boston',   'MA', 'executive'),
  M('p04', 'Law firm partner',  'Executive', 'Latham',        ['M&A', 'Antitrust'],           ['Expand network'], ['Travel'],     'Boston',   'MA', 'professional'),
  M('p05', 'Law firm partner',  'Executive', 'Kirkland',      ['Antitrust', 'Litigation'],    ['Expand network'], ['Sports'],     'Chicago',  'IL', 'professional'),
  M('p06', 'In-house Counsel',  'Mid-Level', 'Initech',       ['Employment', 'Privacy'],      ['Learn & grow'],   ['Reading'],    'Chicago',  'IL', 'free'),
  M('p07', 'Compliance',        'Senior',    'Umbrella Inc',  ['Compliance', 'Privacy'],      ['Expand network'], ['Fitness'],    'Austin',   'TX', 'professional'),
  M('p08', 'Consultant',        'Senior',    'Bain Advisory', ['Strategy', 'Compliance'],     ['Find customers'], ['Fitness'],    'Austin',   'TX', 'professional'),
  M('p09', 'In-house Counsel',  'Senior',    'Acme Corp',     ['Securities', 'M&A'],          ['Learn & grow'],   ['Music'],      'New York', 'NY', 'professional'), // same company as p01
  M('p10', 'Legal Operations',  'Mid-Level', 'Vandelay',      ['Legal Ops', 'Privacy'],       ['Learn & grow'],   ['Music'],      'Denver',   'CO', 'free'),
]

/** Byte-for-byte the hard-gate + scoring loop from app/api/admin/generate-batch/route.ts. */
function buildPairGraph() {
  const ctx = buildScoringContext(FIXTURE, undefined, 'golden-baseline')
  const pairs: Array<{ a: string; b: string; scoreAtoB: number; scoreBtoA: number; mutual: number; avg: number }> = []
  for (let i = 0; i < FIXTURE.length; i++) {
    for (let j = i + 1; j < FIXTURE.length; j++) {
      const A = FIXTURE[i], B = FIXTURE[j]
      if (isSameSideLegalPair(A, B)) continue          // absolute exclusion
      if (isSameCompany(A, B)) continue                // absolute exclusion
      const scoreAtoB = scoreMatch(A, B, ctx)
      const scoreBtoA = scoreMatch(B, A, ctx)
      pairs.push({
        a: A.id, b: B.id, scoreAtoB, scoreBtoA,
        mutual: scoreAtoB + scoreBtoA,
        avg: (scoreAtoB + scoreBtoA) / 2,
      })
    }
  }
  return { ctx, pairs }
}

function solve(pairs: ReturnType<typeof buildPairGraph>['pairs']) {
  const byId = new Map(FIXTURE.map((m) => [m.id, m]))
  const capOf = (m: any) => perRecipientIntroLimit(m.subscription_tier || 'free')
  const capacityByMember = new Map<string, number>()
  const existingVisibleByMember = new Map<string, number>()
  for (const m of FIXTURE) {
    existingVisibleByMember.set(m.id, 0)
    capacityByMember.set(m.id, visibleDeficit(0, MAX_VISIBLE_INTRO_CARDS))
  }
  const edges = pairs.map((p) => ({
    userA: byId.get(p.a)!, userB: byId.get(p.b)!, mutualScore: p.mutual,
  }))
  return solveGlobalBMatching(edges as any, {
    capacityByMember,
    existingVisibleByMember,
    qualityAdjustment: crossMarketAdjustment(lawFirmRole),
    providerCapOf: (id: string) => { const m = byId.get(id); return m ? maxBusinessSolutionCount(m.open_to_business_solutions || false, m.subscription_tier || 'free', capOf(m)) : 0 },
    isProviderFor: (member: any, other: any) => {
      if (isBusinessSolutionProvider(member) && isBusinessSolutionProvider(other)) return false
      if (isLegalNetworkingPair(member, other)) return false
      return isBusinessSolutionProvider(other)
    },
    roleOf: (m: any) => String(m?.role_type ?? 'unknown'),
    roleCapOf: (id: string) => { const m = byId.get(id); return m ? Math.max(1, Math.ceil(capOf(m) * 0.5)) : 1 },
    roleRepeatPenalty: 25,
  } as any)
}

/** Stable, human-diffable signature: every selected edge with both directional scores. */
function signature() {
  const { pairs } = buildPairGraph()
  const result = solve(pairs)
  const byKey = new Map(pairs.map((p) => [`${p.a}|${p.b}`, p]))
  return (result.selected as any[])
    .map((e) => {
      const k = e.userA.id < e.userB.id ? `${e.userA.id}|${e.userB.id}` : `${e.userB.id}|${e.userA.id}`
      const p = byKey.get(k)!
      return `${k} a2b=${p.scoreAtoB} b2a=${p.scoreBtoA} mutual=${p.mutual}`
    })
    .sort()
}

describe('GOLDEN: algorithm identity is pinned', () => {
  it('algorithm + scoring model versions are unchanged', () => {
    expect(RECOMMENDATION_ALGORITHM_VERSION).toBe('v3.4')
    expect(SCORING_MODEL_VERSION).toBe('v2.0.0')
  })

  it('the scoring config hash records every input to a batch', () => {
    // WHAT THIS PIN ORIGINALLY SAID, AND WHY IT NEEDED CORRECTING. It read: "If it changes,
    // Professional scores changed." That was true while SCORING_CONFIG and BATCH_CONFIG were the
    // only things in the snapshot. Step 3.5 added NEXT_SCORING_CONFIG — the Andrel Next expertise
    // semantics and the Next relevance floor — because those are genuinely part of what produced a
    // batch and belong in a reproducibility stamp. So the hash now also moves when NEXT config
    // changes, with no Professional consequence whatsoever.
    //
    // df26f0c8 -> bec34e9e for exactly that reason. The claim the original pin was protecting is
    // still enforced, and by something stronger than a hash: the eight other tests in THIS file —
    // hard-gate admission, every directional score, the selected edge set, capacity and solver
    // determinism — all pass unchanged, as do the 65 fixtures in professional-scoring-golden.
    expect(algorithmConfigHash()).toMatchInlineSnapshot(`"bec34e9e"`)
  })

  it('per-tier batch sizes are unchanged', () => {
    expect(effectiveTierDistribution('free').total).toBe(2)
    expect(effectiveTierDistribution('professional').total).toBe(2)
    expect(effectiveTierDistribution('executive').total).toBe(2)
  })
})

describe('GOLDEN: the Professional pair graph', () => {
  it('the hard gates admit exactly the expected edges (missing/additional pairs)', () => {
    const { pairs } = buildPairGraph()
    expect(pairs.map((p) => `${p.a}|${p.b}`).sort()).toMatchInlineSnapshot(`
      [
        "p01|p02",
        "p01|p03",
        "p01|p04",
        "p01|p05",
        "p01|p06",
        "p01|p07",
        "p01|p08",
        "p01|p10",
        "p02|p03",
        "p02|p06",
        "p02|p07",
        "p02|p08",
        "p02|p09",
        "p02|p10",
        "p03|p04",
        "p03|p05",
        "p03|p06",
        "p03|p07",
        "p03|p08",
        "p03|p09",
        "p03|p10",
        "p04|p06",
        "p04|p07",
        "p04|p08",
        "p04|p09",
        "p04|p10",
        "p05|p06",
        "p05|p07",
        "p05|p08",
        "p05|p09",
        "p05|p10",
        "p06|p07",
        "p06|p08",
        "p06|p09",
        "p06|p10",
        "p07|p08",
        "p07|p09",
        "p07|p10",
        "p08|p09",
        "p08|p10",
        "p09|p10",
      ]
    `)
  })

  it('same-company and same-side-legal pairs are excluded', () => {
    const { pairs } = buildPairGraph()
    const keys = new Set(pairs.map((p) => `${p.a}|${p.b}`))
    expect(keys.has('p01|p09')).toBe(false)   // both Acme Corp
    expect(keys.has('p04|p05')).toBe(false)   // two law-firm partners
    expect(keys.has('p02|p04')).toBe(false)   // law-firm attorney + law-firm partner
  })

  it('every directional score is unchanged', () => {
    const { pairs } = buildPairGraph()
    const scores = pairs.map((p) => `${p.a}->${p.b}=${p.scoreAtoB} ${p.b}->${p.a}=${p.scoreBtoA}`).sort()
    expect(scores).toMatchInlineSnapshot(`
      [
        "p01->p02=65 p02->p01=65",
        "p01->p03=41 p03->p01=34",
        "p01->p04=34 p04->p01=34",
        "p01->p05=34 p05->p01=34",
        "p01->p06=46 p06->p01=54",
        "p01->p07=47 p07->p01=47",
        "p01->p08=39 p08->p01=39",
        "p01->p10=46 p10->p01=54",
        "p02->p03=49 p03->p02=42",
        "p02->p06=34 p06->p02=42",
        "p02->p07=59 p07->p02=59",
        "p02->p08=39 p08->p02=39",
        "p02->p09=55 p09->p02=55",
        "p02->p10=34 p10->p02=42",
        "p03->p04=65 p04->p03=72",
        "p03->p05=39 p05->p03=46",
        "p03->p06=26 p06->p03=41",
        "p03->p07=34 p07->p03=41",
        "p03->p08=34 p08->p03=41",
        "p03->p09=34 p09->p03=41",
        "p03->p10=26 p10->p03=41",
        "p04->p06=26 p06->p04=34",
        "p04->p07=46 p07->p04=46",
        "p04->p08=34 p08->p04=34",
        "p04->p09=42 p09->p04=42",
        "p04->p10=26 p10->p04=34",
        "p05->p06=34 p06->p05=42",
        "p05->p07=46 p07->p05=46",
        "p05->p08=34 p08->p05=34",
        "p05->p09=34 p09->p05=34",
        "p05->p10=26 p10->p05=34",
        "p06->p07=42 p07->p06=34",
        "p06->p08=34 p08->p06=26",
        "p06->p09=46 p09->p06=38",
        "p06->p10=51 p10->p06=51",
        "p07->p08=65 p08->p07=65",
        "p07->p09=39 p09->p07=39",
        "p07->p10=34 p10->p07=42",
        "p08->p09=39 p09->p08=39",
        "p08->p10=26 p10->p08=34",
        "p09->p10=48 p10->p09=56",
      ]
    `)
  })
})

describe('GOLDEN: the b-matching selection', () => {
  it('the selected edge set and its scores are unchanged', () => {
    expect(signature()).toMatchInlineSnapshot(`
      [
        "p01|p02 a2b=65 b2a=65 mutual=130",
        "p01|p06 a2b=46 b2a=54 mutual=100",
        "p02|p07 a2b=59 b2a=59 mutual=118",
        "p03|p04 a2b=65 b2a=72 mutual=137",
        "p03|p09 a2b=34 b2a=41 mutual=75",
        "p04|p08 a2b=34 b2a=34 mutual=68",
        "p05|p06 a2b=34 b2a=42 mutual=76",
        "p05|p10 a2b=26 b2a=34 mutual=60",
        "p07|p08 a2b=65 b2a=65 mutual=130",
        "p09|p10 a2b=48 b2a=56 mutual=104",
      ]
    `)
  })

  it('no member exceeds their visible capacity (batch size)', () => {
    const { pairs } = buildPairGraph()
    const result = solve(pairs)
    const per = new Map<string, number>()
    for (const e of result.selected as any[]) {
      per.set(e.userA.id, (per.get(e.userA.id) ?? 0) + 1)
      per.set(e.userB.id, (per.get(e.userB.id) ?? 0) + 1)
    }
    for (const [, n] of Array.from(per)) expect(n).toBeLessThanOrEqual(MAX_VISIBLE_INTRO_CARDS)
    expect(Object.fromEntries(Array.from(per).sort())).toMatchInlineSnapshot(`
      {
        "p01": 2,
        "p02": 2,
        "p03": 2,
        "p04": 2,
        "p05": 2,
        "p06": 2,
        "p07": 2,
        "p08": 2,
        "p09": 2,
        "p10": 2,
      }
    `)
  })

  it('the solver is deterministic across repeated runs', () => {
    expect(signature()).toEqual(signature())
    expect(signature()).toEqual(signature())
  })
})
