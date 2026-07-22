import { describe, it, expect } from 'vitest'
import { selectReciprocalGraph, reciprocalPairKey, type ReciprocalEdgeInput } from '@/lib/matching/reciprocal-graph'

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
