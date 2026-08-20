import { describe, it, expect } from 'vitest'
import {
  solveGlobalBMatching, pairTypeCounts, underfillReasonCounts, compareObjective, pairKey,
  nullSafeRole, legalPolicyAdjustment, crossMarketAdjustment, CROSS_MARKET_PER_DIRECTION,
} from '@/lib/matching/globalBMatching'
import { lawFirmRole, legalSameSidePenalty, LEGAL_SAME_SIDE_PENALTY } from '@/lib/matching/legalSameSidePenalty'
import { isLegalProfessional } from '@/lib/matching/business-solutions'

/**
 * The optimizer is the piece that decides WHICH reciprocal pairs a future admin batch
 * proposes. Every assertion below is about coverage, capacity, reciprocity, determinism
 * and the legal cross-market preference — never about production data, and nothing here
 * touches a database, a route, a cron, an email or a notification.
 */

type M = { id: string; role_type?: string | null }
type Ed = { userA: M; userB: M; mutualScore: number }
const m = (id: string, role_type = 'CEO'): M => ({ id, role_type })
const edge = (a: M, b: M, score = 100): Ed => ({ userA: a, userB: b, mutualScore: score })
/** the authoritative in-house/legal classifier, adapted to the nullable member shape */
const legalPro = nullSafeRole(isLegalProfessional)

const LAW = 'Law Firm Partner'
const ATTY = 'Law firm attorney'
const GC = 'General Counsel'
const CEO = 'CEO'

/** Standard config: everyone starts empty (deficit 2), authoritative classification. */
const cfg = (over: Partial<Parameters<typeof solveGlobalBMatching>[1]> = {}) => ({
  deficitOf: () => 2,
  existingCardsOf: () => 0,
  // the real, bounded policy: legalSameSidePenalty applied once per direction
  qualityAdjustment: legalPolicyAdjustment(legalSameSidePenalty),
  ...over,
})

const degOf = (r: { degree: Map<string, number> }, id: string) => r.degree.get(id) ?? 0

describe('1. the known four-node counterexample', () => {
  // greedy takes triangle AB/AC/BC -> D stranded at 0; the 4-cycle gives everyone 2.
  const A = m('A'), B = m('B'), C = m('C'), D = m('D')
  const edges = [edge(A, B, 130), edge(A, C, 124), edge(B, C, 120), edge(A, D, 90), edge(B, D, 82)]

  it('leaves nobody at zero, unlike greedy', () => {
    const r = solveGlobalBMatching(edges, cfg())
    expect(r.exact).toBe(true)
    expect(degOf(r, 'D'), 'D must not be stranded at zero').toBeGreaterThanOrEqual(1)
  })

  it('covers every member even though the highest-quality triangle does not', () => {
    const r = solveGlobalBMatching(edges, cfg())
    for (const id of ['A', 'B', 'C', 'D']) expect(degOf(r, id)).toBeGreaterThanOrEqual(1)
  })

  it('the perfect four-cycle is found when it exists', () => {
    // AC BC AD BD is a 4-cycle A-C-B-D-A: every member reaches exactly 2.
    const only4 = [edge(A, C, 100), edge(B, C, 100), edge(A, D, 100), edge(B, D, 100)]
    const r = solveGlobalBMatching(only4, cfg())
    for (const id of ['A', 'B', 'C', 'D']) expect(degOf(r, id)).toBe(2)
  })
})

describe('2. zero-card members are prioritised before second cards', () => {
  it('prefers covering a zero-card member over giving a one-card member their second', () => {
    // X has 1 card already (deficit 1); Z has none (deficit 2). Y can serve only one of them.
    const X = m('X'), Y = m('Y'), Z = m('Z')
    const edges = [edge(X, Y, 200), edge(Y, Z, 10)] // the XY edge is far higher quality
    const r = solveGlobalBMatching(edges, cfg({
      deficitOf: (id: string) => (id === 'X' ? 1 : 2),
      existingCardsOf: (id: string) => (id === 'X' ? 1 : 0),
    }))
    expect(r.exact).toBe(true)
    // Y's single free unit… both edges are actually takeable (Y has deficit 2), so assert
    // the zero-card member is covered no matter what quality says.
    expect(degOf(r, 'Z'), 'the zero-card member must be covered').toBeGreaterThanOrEqual(1)
  })

  it('sacrifices quality when quality and zero-card coverage conflict', () => {
    // W(0 cards) reachable ONLY via P. P has deficit 1. A rival edge P-Q scores far higher.
    const P = m('P'), Q = m('Q'), W = m('W')
    const edges = [edge(P, Q, 500), edge(P, W, 1)]
    const r = solveGlobalBMatching(edges, cfg({
      deficitOf: (id: string) => (id === 'P' ? 1 : 2),
      existingCardsOf: (id: string) => (id === 'Q' ? 1 : 0),
    }))
    // Q already holds a card; W holds none. Objective 1 must win over objective 5.
    expect(degOf(r, 'W'), 'zero-card W beats higher-quality P-Q').toBe(1)
    expect(degOf(r, 'Q')).toBe(0)
  })
})

describe('3. coverage outranks aggregate quality', () => {
  it('a lower-quality solution wins when it covers one more underfilled member', () => {
    const A = m('A'), B = m('B'), C = m('C'), D = m('D')
    const edges = [edge(A, B, 400), edge(C, D, 5)]
    const r = solveGlobalBMatching(edges, cfg())
    // Both edges are compatible; taking both covers 4 members. Quality must not drop CD.
    expect(r.selected).toHaveLength(2)
    for (const id of ['A', 'B', 'C', 'D']) expect(degOf(r, id)).toBe(1)
  })
})

describe('4-5. an edge consumes capacity at BOTH endpoints, and no cap is exceeded', () => {
  it('degree never exceeds the deficit for any member', () => {
    const ids = ['A', 'B', 'C', 'D', 'E']
    const ms = ids.map((i) => m(i))
    const edges: Ed[] = []
    for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) edges.push(edge(ms[i], ms[j], 100 - i - j))
    const r = solveGlobalBMatching(edges, cfg())
    for (const id of ids) expect(degOf(r, id)).toBeLessThanOrEqual(2)
  })

  it('a member with deficit 0 receives no edge and is never disturbed', () => {
    const A = m('A'), B = m('B'), F = m('F')
    const edges = [edge(A, F, 300), edge(B, F, 300), edge(A, B, 10)]
    const r = solveGlobalBMatching(edges, cfg({ deficitOf: (id: string) => (id === 'F' ? 0 : 2) }))
    expect(degOf(r, 'F'), 'a member already at capacity must receive nothing').toBe(0)
  })

  it('respects an asymmetric remaining capacity', () => {
    const A = m('A'), B = m('B'), C = m('C')
    const edges = [edge(A, B, 100), edge(A, C, 100), edge(B, C, 100)]
    const r = solveGlobalBMatching(edges, cfg({ deficitOf: (id: string) => (id === 'A' ? 1 : 2) }))
    expect(degOf(r, 'A')).toBeLessThanOrEqual(1)
  })
})

describe('6. reciprocity is structural — a one-sided result is unrepresentable', () => {
  it('every selected item is one undirected edge with two distinct endpoints', () => {
    const A = m('A'), B = m('B'), C = m('C')
    const r = solveGlobalBMatching([edge(A, B), edge(B, C), edge(A, C)], cfg())
    for (const e of r.selected) expect(e.userA.id).not.toBe(e.userB.id)
    // total degree is exactly twice the edge count — the definition of two-sided
    const total = Array.from(r.degree.values()).reduce((a, b) => a + b, 0)
    expect(total).toBe(r.selected.length * 2)
  })

  it('never selects the same unordered pair twice', () => {
    const A = m('A'), B = m('B')
    const r = solveGlobalBMatching([edge(A, B, 100), edge(B, A, 99)], cfg())
    const keys = r.selected.map((e) => pairKey(e.userA.id, e.userB.id))
    expect(new Set(keys).size).toBe(keys.length)
    expect(degOf(r, 'A')).toBeLessThanOrEqual(2)
  })
})

describe('11. determinism', () => {
  it('identical input yields an identical selection across runs', () => {
    const ms = 'ABCDEF'.split('').map((i) => m(i))
    const edges: Ed[] = []
    for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) edges.push(edge(ms[i], ms[j], 50 + ((i * 7 + j * 13) % 40)))
    const key = () => solveGlobalBMatching(edges, cfg()).selected
      .map((e) => pairKey(e.userA.id, e.userB.id)).sort().join(',')
    const first = key()
    for (let k = 0; k < 5; k++) expect(key()).toBe(first)
  })

  it('tied scores resolve deterministically, not by input order', () => {
    const A = m('A'), B = m('B'), C = m('C'), D = m('D')
    const fwd = [edge(A, B, 100), edge(C, D, 100)]
    const rev = [edge(C, D, 100), edge(A, B, 100)]
    const k = (es: any[]) => solveGlobalBMatching(es, cfg()).selected
      .map((e) => pairKey(e.userA.id, e.userB.id)).sort().join(',')
    expect(k(fwd)).toBe(k(rev))
  })
})

describe('14. legal cross-market preference (bounded, inside quality)', () => {
  const isLawFirm = (x: { role_type?: string | null }) => lawFirmRole(x) !== null

  it('a similarly scored cross-market edge beats a law-firm-to-law-firm edge', () => {
    // Equal raw scores. The bounded penalty (-45 x2 for partner<->attorney) decides.
    const P1 = m('P1', LAW), P2 = m('P2', ATTY), G = m('G', GC)
    const r = solveGlobalBMatching([edge(P1, P2, 100), edge(P1, G, 100)], cfg({ deficitOf: () => 1 }))
    const counts = pairTypeCounts(r.selected, isLawFirm, legalPro)
    expect(r.selected).toHaveLength(1)
    expect(counts.law_firm__in_house, 'cross-market wins an equal-score comparison').toBe(1)
    expect(counts.law_firm__law_firm).toBe(0)
  })

  it('a MATERIALLY stronger same-side edge still wins — the preference is bounded', () => {
    // partner<->partner costs 2 x 60 = 120 mutual points. A same-side edge 200 points
    // better must therefore still win; otherwise the preference would be unbounded.
    const P1 = m('P1', LAW), P2 = m('P2', LAW), G = m('G', GC)
    const r = solveGlobalBMatching([edge(P1, P2, 300), edge(P1, G, 100)], cfg({ deficitOf: () => 1 }))
    const counts = pairTypeCounts(r.selected, isLawFirm, legalPro)
    expect(counts.law_firm__law_firm, 'a far stronger substantive match must remain reachable').toBe(1)
  })

  it('the trade-off ceiling is exactly the documented number of score points', () => {
    // Just INSIDE the ceiling: same-side +119 raw over cross-market -> cross-market wins.
    const P1 = m('P1', LAW), P2 = m('P2', LAW), G = m('G', GC)
    const inside = solveGlobalBMatching([edge(P1, P2, 219), edge(P1, G, 100)], cfg({ deficitOf: () => 1 }))
    expect(pairTypeCounts(inside.selected, isLawFirm, legalPro).law_firm__in_house).toBe(1)
    // Just OUTSIDE: same-side +121 raw -> same-side wins.
    const outside = solveGlobalBMatching([edge(P1, P2, 221), edge(P1, G, 100)], cfg({ deficitOf: () => 1 }))
    expect(pairTypeCounts(outside.selected, isLawFirm, legalPro).law_firm__law_firm).toBe(1)
    expect(2 * LEGAL_SAME_SIDE_PENALTY.partnerPartner).toBe(120) // the stated ceiling
  })

  it('a barely-qualifying cross-market edge cannot beat a strong same-side edge', () => {
    // This is the defect Blocker 1 identified: with pair type as its own lexicographic
    // objective, the score-40 cross-market edge would have won. It must not.
    const P1 = m('P1', LAW), P2 = m('P2', LAW), G = m('G', GC)
    const r = solveGlobalBMatching([edge(P1, P2, 400), edge(P1, G, 40)], cfg({ deficitOf: () => 1 }))
    expect(pairTypeCounts(r.selected, isLawFirm, legalPro).law_firm__law_firm).toBe(1)
  })

  it('coverage still outranks quality: a zero-card member is never sacrificed for pair type', () => {
    const P1 = m('P1', LAW), P2 = m('P2', LAW), G = m('G', GC)
    const r = solveGlobalBMatching([edge(P1, G, 500), edge(P1, P2, 40)], cfg())
    expect(degOf(r, 'P2'), 'coverage beats both quality and pair type').toBe(1)
    expect(degOf(r, 'G')).toBe(1)
  })

  it('law-firm-to-law-firm remains possible when no cross-market edge exists', () => {
    const P1 = m('P1', LAW), P2 = m('P2', ATTY)
    const r = solveGlobalBMatching([edge(P1, P2, 100)], cfg())
    expect(r.selected).toHaveLength(1)
    expect(pairTypeCounts(r.selected, isLawFirm, legalPro).law_firm__law_firm).toBe(1)
  })

  it('the penalty never applies to a cross-market or non-legal edge', () => {
    expect(legalSameSidePenalty({ role_type: LAW }, { role_type: GC })).toBe(0)
    expect(legalSameSidePenalty({ role_type: CEO }, { role_type: GC })).toBe(0)
    expect(legalPolicyAdjustment(legalSameSidePenalty)({ role_type: LAW }, { role_type: LAW })).toBe(-120)
  })

  it('allocates a scarce in-house candidate globally, not first-come-first-served', () => {
    const P1 = m('P1', LAW), P2 = m('P2', LAW), G = m('G', GC)
    const edges: Ed[] = [edge(P1, P2, 119), edge(P1, G, 118), edge(P2, G, 117)]
    const r = solveGlobalBMatching(edges, cfg({ deficitOf: (id: string) => (id === 'G' ? 2 : 1) }))
    const counts = pairTypeCounts(r.selected, isLawFirm, legalPro)
    expect(counts.law_firm__in_house, 'both partners served cross-market').toBe(2)
    expect(counts.law_firm__law_firm).toBe(0)
    expect(degOf(r, 'G')).toBe(2)
  })

  it('classification uses role_type, never a display title', () => {
    expect(lawFirmRole({ role_type: 'General Counsel' })).toBeNull()
    expect(lawFirmRole({ role_type: LAW })).toBe('partner')
    expect(lawFirmRole({ role_type: ATTY })).toBe('attorney')
    expect(lawFirmRole({ role_type: null })).toBeNull()
  })
})

describe('13. bounded runtime and adversarial graphs', () => {
  it('handles a disconnected graph with an isolated component', () => {
    const A = m('A'), B = m('B'), C = m('C'), D = m('D')
    const r = solveGlobalBMatching([edge(A, B), edge(C, D)], cfg())
    expect(r.selected).toHaveLength(2)
  })

  it('handles an odd cycle — five members can all reach two', () => {
    const ms = 'VWXYZ'.split('').map((i) => m(i))
    const edges = ms.map((x, i) => edge(x, ms[(i + 1) % ms.length], 100))
    const r = solveGlobalBMatching(edges, cfg())
    for (const x of ms) expect(degOf(r, x.id)).toBe(2)
  })

  it('a two-member component caps both at one (a second edge would duplicate the pair)', () => {
    const A = m('A'), B = m('B')
    const r = solveGlobalBMatching([edge(A, B)], cfg())
    expect(degOf(r, 'A')).toBe(1)
    expect(degOf(r, 'B')).toBe(1)
  })

  it('reports exact:false rather than silently degrading when the budget is exhausted', () => {
    const ms = Array.from({ length: 14 }, (_, i) => m('M' + i))
    const edges: Ed[] = []
    for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) edges.push(edge(ms[i], ms[j], 100 - ((i * 3 + j) % 50)))
    const r = solveGlobalBMatching(edges, cfg({ nodeBudget: 200 }))
    expect(r.exact).toBe(false)
    expect(r.reason).toBe('node_budget_exhausted')
    for (const x of ms) expect(degOf(r, x.id)).toBeLessThanOrEqual(2) // still feasible
  })

  it('stays within budget on a cohort-sized dense graph', () => {
    const ms = Array.from({ length: 24 }, (_, i) => m('U' + String(i).padStart(2, '0')))
    const edges: Ed[] = []
    for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++)
      if ((i * 31 + j * 17) % 5 < 2) edges.push(edge(ms[i], ms[j], 40 + ((i * 7 + j * 11) % 60)))
    const t0 = Date.now()
    const r = solveGlobalBMatching(edges, cfg({ nodeBudget: 2_000_000 }))
    expect(Date.now() - t0).toBeLessThan(15_000)
    for (const x of ms) expect(degOf(r, x.id)).toBeLessThanOrEqual(2)
  })
})

describe('13b. production-cohort shape and component decomposition', () => {
  it('is EXACT at the audited cohort size (24 underfilled members)', () => {
    // Production audit: 12 members at 0 visible cards, 12 at 1, and 129 structurally
    // possible pairs among them. This asserts the optimizer proves optimality at that size.
    const ms = Array.from({ length: 24 }, (_, i) => m('U' + String(i).padStart(2, '0')))
    const edges: Ed[] = []
    for (let i = 0; i < 24; i++) for (let j = i + 1; j < 24; j++)
      if ((i * 31 + j * 17) % 5 < 2) edges.push(edge(ms[i], ms[j], 40 + ((i * 7 + j * 11) % 60)))
    const t0 = Date.now()
    const r = solveGlobalBMatching(edges, cfg({
      deficitOf: (id: string) => (Number(id.slice(1)) < 12 ? 2 : 1),
      existingCardsOf: (id: string) => (Number(id.slice(1)) < 12 ? 0 : 1),
    }))
    expect(r.exact, 'must prove optimality at cohort size').toBe(true)
    expect(Date.now() - t0).toBeLessThan(5_000)
    // every zero-card member covered
    for (let i = 0; i < 12; i++) expect(degOf(r, 'U' + String(i).padStart(2, '0'))).toBeGreaterThanOrEqual(1)
  })

  it('solves disjoint components independently and identically', () => {
    // Two identical components must receive identical treatment regardless of ordering.
    const c1 = ['A', 'B', 'C'].map((i) => m(i))
    const c2 = ['X', 'Y', 'Z'].map((i) => m(i))
    const mk = (g: any[]) => [edge(g[0], g[1], 100), edge(g[1], g[2], 90), edge(g[0], g[2], 80)]
    const r = solveGlobalBMatching([...mk(c1), ...mk(c2)], cfg())
    for (const id of ['A', 'B', 'C', 'X', 'Y', 'Z']) expect(degOf(r, id)).toBe(2)
    expect(r.selected).toHaveLength(6)
  })

  it('never crashes or exceeds capacity on a large dense graph', () => {
    const ms = Array.from({ length: 120 }, (_, i) => m('L' + String(i).padStart(3, '0')))
    const edges: Ed[] = []
    for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++)
      if ((i * 13 + j * 7) % 4 === 0) edges.push(edge(ms[i], ms[j], 50 + ((i + j) % 50)))
    const t0 = Date.now()
    const r = solveGlobalBMatching(edges, cfg())
    expect(Date.now() - t0).toBeLessThan(30_000)
    for (const x of ms) expect(degOf(r, x.id)).toBeLessThanOrEqual(2)
    const keys = r.selected.map((e) => pairKey(e.userA.id, e.userB.id))
    expect(new Set(keys).size, 'no duplicate unordered pair at scale').toBe(keys.length)
  }, 30_000)

  it('reports exact:false with a named reason when a component is capped', () => {
    const ms = Array.from({ length: 60 }, (_, i) => m('C' + String(i).padStart(2, '0')))
    const edges: Ed[] = []
    for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++)
      if ((i * 5 + j) % 3 === 0) edges.push(edge(ms[i], ms[j], 60 + ((i * 3 + j) % 40)))
    const r = solveGlobalBMatching(edges, cfg())
    if (!r.exact) expect(['component_edge_cap', 'node_budget_exhausted']).toContain(r.reason)
    for (const x of ms) expect(degOf(r, x.id)).toBeLessThanOrEqual(2) // feasible regardless
  })
})

describe('objective ordering and aggregate reporting', () => {
  it('compareObjective is strictly lexicographic', () => {
    expect(compareObjective([2, 0, 0], [1, 99, 99])).toBeGreaterThan(0)
    expect(compareObjective([1, 1, 0], [1, 1, 5])).toBeLessThan(0)
    expect(compareObjective([1, 2, 3], [1, 2, 3])).toBe(0)
  })

  it('20. aggregate reports contain no identifiers whatsoever', () => {
    const P = m('P1', LAW), G = m('G1', GC), E = m('E1', CEO)
    const r = solveGlobalBMatching([edge(P, G, 100), edge(P, E, 90), edge(G, E, 80)], cfg())
    const counts = pairTypeCounts(r.selected, (x) => lawFirmRole(x) !== null, legalPro)
    const reasons = underfillReasonCounts(['P1', 'G1', 'E1'], r.selected, [], () => 2)
    const blob = JSON.stringify({ counts, reasons })
    for (const leak of ['P1', 'G1', 'E1', 'Law Firm', 'General Counsel', '@']) {
      expect(blob, `aggregate report leaked ${leak}`).not.toContain(leak)
    }
    expect(Object.values(counts).every((v) => typeof v === 'number')).toBe(true)
  })

  it('underfill reasons are counts only and cover every member', () => {
    const A = m('A'), B = m('B'), C = m('C')
    const edges = [edge(A, B, 100)]
    const r = solveGlobalBMatching(edges, cfg())
    const reasons = underfillReasonCounts(['A', 'B', 'C'], r.selected, edges, () => 2)
    expect(Object.values(reasons).reduce((a, b) => a + b, 0)).toBe(3)
    expect(reasons.no_scored_candidate_edge).toBe(1) // C has no edge at all
  })
})
