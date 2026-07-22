import { describe, it, expect } from 'vitest'
import { selectReciprocalGraph, augmentForCoverage, reciprocalPairKey, type ReciprocalEdgeInput } from '@/lib/matching/reciprocal-graph'

// Minimal member factory. role_type drives the role-diversity cap.
const M = (id: string, extra: Record<string, any> = {}) => ({ id, role_type: 'lawyer', subscription_tier: 'free', ...extra })

// Build an undirected edge with a symmetric score unless overridden.
const E = (a: any, b: any, aToB: number, bToA = aToB): ReciprocalEdgeInput => ({
  userA: a, userB: b, scoreAtoB: aToB, scoreBtoA: bToA, mutualScore: aToB + bToA,
})

// Emit the two directed rows an edge becomes, exactly as the route does.
const emitDirected = (selected: ReciprocalEdgeInput[]) => {
  const rows: Array<[string, string]> = []
  for (const e of selected) {
    rows.push([e.userA.id, e.userB.id])
    rows.push([e.userB.id, e.userA.id])
  }
  return rows
}

const cap2 = { capOf: () => 2, maxSameRolePercent: 1 } // role cap effectively off (ceil(2*1)=2)

describe('selectReciprocalGraph — reciprocity invariant', () => {
  it('every selected edge produces both directions (no one-way edge is possible)', () => {
    const a = M('a'), b = M('b'), c = M('c'), d = M('d')
    const edges = [E(a, b, 80), E(a, c, 70), E(b, c, 60), E(c, d, 50), E(a, d, 90)]
    const { selected } = selectReciprocalGraph(edges, cap2)
    const rows = emitDirected(selected)
    const set = new Set(rows.map(([x, y]) => `${x}>${y}`))
    for (const [x, y] of rows) {
      expect(set.has(`${y}>${x}`)).toBe(true) // reverse must exist
    }
    // exactly 2 rows per selected edge, no odd count
    expect(rows.length % 2).toBe(0)
  })

  it('appears-in count equals receives count for every member (degree symmetry)', () => {
    const nodes = Array.from({ length: 8 }, (_, i) => M(`n${i}`))
    const edges: ReciprocalEdgeInput[] = []
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++)
        edges.push(E(nodes[i], nodes[j], 40 + ((i * 7 + j * 13) % 50)))
    const { selected } = selectReciprocalGraph(edges, cap2)
    const appears: Record<string, number> = {}
    const receives: Record<string, number> = {}
    for (const [recipient, suggested] of emitDirected(selected)) {
      receives[recipient] = (receives[recipient] || 0) + 1
      appears[suggested] = (appears[suggested] || 0) + 1
    }
    for (const n of nodes) {
      expect(appears[n.id] || 0).toBe(receives[n.id] || 0)
    }
  })
})

describe('selectReciprocalGraph — degree cap in both directions', () => {
  it('no member exceeds their cap (bounds visibility AND receipt at once)', () => {
    // A "popular" hub (h) that many members would independently pick — the Sonali/Justin
    // scenario. Under the graph, h can be in at most `cap` edges, so appears == receives == cap.
    const hub = M('hub')
    const others = Array.from({ length: 6 }, (_, i) => M(`o${i}`))
    const edges = others.map(o => E(hub, o, 95)) // everyone wants the hub, all equal top score
    // plus some edges among the others so they have alternatives
    for (let i = 0; i < others.length; i++)
      for (let j = i + 1; j < others.length; j++)
        edges.push(E(others[i], others[j], 50))
    const { selected, degree } = selectReciprocalGraph(edges, cap2)
    for (const d of Array.from(degree.values())) expect(d).toBeLessThanOrEqual(2)
    const hubEdges = selected.filter(e => e.userA.id === 'hub' || e.userB.id === 'hub')
    expect(hubEdges.length).toBeLessThanOrEqual(2) // hub bounded — cannot appear in 6 lists
  })

  it('honors per-member caps that differ by tier', () => {
    const exec = M('exec', { subscription_tier: 'executive' })
    const frees = Array.from({ length: 5 }, (_, i) => M(`f${i}`))
    const edges = frees.map(f => E(exec, f, 90))
    const capByTier = { capOf: (m: any) => (m.subscription_tier === 'executive' ? 4 : 2), maxSameRolePercent: 1 }
    const { degree } = selectReciprocalGraph(edges, capByTier)
    expect(degree.get('exec')).toBeLessThanOrEqual(4)
    for (const f of frees) expect(degree.get(f.id) || 0).toBeLessThanOrEqual(2)
  })
})

describe('selectReciprocalGraph — quality maximization (greedy)', () => {
  it('prefers higher mutual-quality edges', () => {
    const a = M('a'), b = M('b'), c = M('c')
    // a can pair with b (weight 180) or c (weight 100). With cap 1, greedy takes b.
    const edges = [E(a, c, 50), E(a, b, 90)]
    const { selected } = selectReciprocalGraph(edges, { capOf: () => 1, maxSameRolePercent: 1 })
    expect(selected).toHaveLength(1)
    expect(reciprocalPairKey(selected[0].userA.id, selected[0].userB.id)).toBe('a|b')
  })
})

describe('selectReciprocalGraph — determinism', () => {
  it('input order does not change the selected set', () => {
    const nodes = Array.from({ length: 7 }, (_, i) => M(`z${i}`))
    const edges: ReciprocalEdgeInput[] = []
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++)
        edges.push(E(nodes[i], nodes[j], 40 + ((i * 3 + j * 5) % 40)))
    const keyOf = (sel: ReciprocalEdgeInput[]) =>
      sel.map(e => reciprocalPairKey(e.userA.id, e.userB.id)).sort().join(',')
    const forward = selectReciprocalGraph(edges, cap2)
    const reversed = selectReciprocalGraph(edges.slice().reverse(), cap2)
    expect(keyOf(reversed.selected)).toBe(keyOf(forward.selected))
  })
})

describe('selectReciprocalGraph — role diversity cap', () => {
  it('limits how many same-role partners a member gets', () => {
    // cap 2, maxSameRolePercent 0.4 → ceil(0.8)=1 per role. `a` has 3 lawyer suitors;
    // it can accept at most 1 lawyer, so degree(a) is limited by role, not cap.
    const a = M('a', { role_type: 'founder' })
    const lawyers = Array.from({ length: 3 }, (_, i) => M(`L${i}`, { role_type: 'lawyer' }))
    const edges = lawyers.map(l => E(a, l, 90))
    const { degree } = selectReciprocalGraph(edges, { capOf: () => 2, maxSameRolePercent: 0.4 })
    expect(degree.get('a')).toBe(1)
  })
})

describe('augmentForCoverage — recovers members greedy strands', () => {
  const weight = (edges: ReciprocalEdgeInput[]) => edges.reduce((s, e) => s + e.mutualScore, 0)

  it('reroutes a saturated hub to cover stranded members, keeping caps and quality', () => {
    // Greedy fills P with {V,Q} and Q with {P,R}, stranding u (only partner P, full) and
    // T (only partner Q, full). A length-3 reroute (drop P-Q, add u-P + Q-T) seats both.
    const u = M('u'), P = M('P'), V = M('V'), Q = M('Q'), R = M('R'), T = M('T')
    const edges = [E(P, V, 100), E(P, Q, 90), E(Q, R, 80), E(Q, T, 70), E(u, P, 30)]
    const { selected, degree } = selectReciprocalGraph(edges, { capOf: () => 2, maxSameRolePercent: 1 })

    for (const m of [u, P, V, Q, R, T]) expect(degree.get(m.id) || 0).toBeGreaterThanOrEqual(1) // all covered
    for (const d of Array.from(degree.values())) expect(d).toBeLessThanOrEqual(2)                // caps intact
    // still fully reciprocal after augmentation
    const rows = emitDirected(selected)
    const set = new Set(rows.map(([x, y]) => `${x}>${y}`))
    for (const [x, y] of rows) expect(set.has(`${y}>${x}`)).toBe(true)
  })

  it('never lowers total quality relative to its seed (Pareto-safe)', () => {
    const u = M('u'), P = M('P'), V = M('V'), Q = M('Q'), R = M('R'), T = M('T')
    const edges = [E(P, V, 100), E(P, Q, 90), E(Q, R, 80), E(Q, T, 70), E(u, P, 30)]
    const seed = [E(P, V, 100), E(P, Q, 90), E(Q, R, 80)] // the greedy result
    const improved = augmentForCoverage(seed, edges, { capOf: () => 2, maxSameRolePercent: 1 })
    expect(weight(improved)).toBeGreaterThanOrEqual(weight(seed))
    expect(improved.length).toBeGreaterThan(seed.length) // strictly more introductions
  })

  it('is a no-op when the greedy matching is already maximal', () => {
    const a = M('a'), b = M('b') // single pair, both capacity 1
    const edges = [E(a, b, 50)]
    const seed = [E(a, b, 50)]
    const improved = augmentForCoverage(seed, edges, { capOf: () => 1, maxSameRolePercent: 1 })
    expect(improved).toHaveLength(1)
  })

  it('will not create an over-cap or role-violating edge to gain coverage', () => {
    // u's only partner P is a lawyer; P's slots are full of lawyers and u is also a
    // lawyer — any reroute would break P's role cap, so u stays uncovered (correctly).
    const u = M('u', { role_type: 'lawyer' })
    const P = M('P', { role_type: 'founder' })
    const L1 = M('L1', { role_type: 'lawyer' }), L2 = M('L2', { role_type: 'lawyer' })
    const edges = [E(P, L1, 100), E(P, L2, 90), E(u, P, 80)]
    const { degree } = selectReciprocalGraph(edges, { capOf: () => 2, maxSameRolePercent: 0.4 }) // 1 per role
    // P already has one lawyer (role cap = 1); u (lawyer) cannot be added without breaking it.
    expect(degree.get('u') || 0).toBe(0)
    for (const d of Array.from(degree.values())) expect(d).toBeLessThanOrEqual(2)
  })
})

describe('selectReciprocalGraph — business-solution peer exemption (v3.2)', () => {
  // Models Design C: providers are marked with { provider: true }; a member's buyer quota
  // is 1 if opted in ({ openBS: true }), else 0.
  const cfgC = {
    capOf: () => 2,
    maxSameRolePercent: 1,
    isBusinessSolutionProvider: (m: any) => !!m.provider,
    bsCapOf: (m: any) => (m.openBS ? 1 : 0),
  }

  it('provider ↔ provider is PEER networking — matched even when neither has any buyer quota', () => {
    const p1 = M('p1', { provider: true, openBS: false })
    const p2 = M('p2', { provider: true, openBS: false })
    const { selected, degree } = selectReciprocalGraph([E(p1, p2, 100)], cfgC)
    expect(selected).toHaveLength(1) // exempt from the quota
    expect(degree.get('p1')).toBe(1)
    expect(degree.get('p2')).toBe(1)
  })

  it('provider → non-opted buyer is blocked, provider → opted-in buyer is allowed', () => {
    const prov = M('prov', { provider: true, role_type: 'lawyer' })
    const closed = M('closed', { provider: false, openBS: false, role_type: 'founder' })
    const open = M('open', { provider: false, openBS: true, role_type: 'operator' })
    const { degree } = selectReciprocalGraph([E(prov, closed, 90), E(prov, open, 80)], cfgC)
    expect(degree.get('open') || 0).toBe(1)   // opted-in buyer gets the provider
    expect(degree.get('closed') || 0).toBe(0) // non-opted buyer shielded (quota 0)
  })

  it('a buyer is never shown more providers than their quota, but peer edges are unlimited', () => {
    // One opted-in buyer (quota 1) with three provider suitors → only 1 provider edge.
    const buyer = M('buyer', { provider: false, openBS: true, role_type: 'founder' })
    const provs = Array.from({ length: 3 }, (_, i) => M('pr' + i, { provider: true, role_type: 'r' + i }))
    const edges = provs.map((p) => E(buyer, p, 90 - 0))
    const { degree } = selectReciprocalGraph(edges, cfgC)
    expect(degree.get('buyer')).toBe(1) // quota respected — not flooded with vendors
  })
})

describe('selectReciprocalGraph — business-solution throttle', () => {
  it('caps how many business-solution providers a member is shown', () => {
    const a = M('a', { role_type: 'founder' })
    const providers = Array.from({ length: 3 }, (_, i) => M(`p${i}`, { role_type: `svc${i}` }))
    const edges = providers.map(p => E(a, p, 90))
    const { degree } = selectReciprocalGraph(edges, {
      capOf: () => 2,
      maxSameRolePercent: 1,
      isBusinessSolutionProvider: (m) => m.id.startsWith('p'),
      bsCapOf: () => 1, // at most one BS provider for `a`
    })
    expect(degree.get('a')).toBe(1)
  })
})
