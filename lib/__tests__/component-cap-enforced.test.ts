import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { reduceComponentToCap, solveGlobalBMatching, type BEdge } from '@/lib/matching/globalBMatching'

const SRC = readFileSync('lib/matching/globalBMatching.ts', 'utf8')

// mulberry32 — deterministic, and stays inside 32-bit ints.
let seed = 11 >>> 0
const rnd = () => {
  seed = (seed + 0x6D2B79F5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
type E = BEdge & { mutualScore: number }
const graph = (n: number, density: number): E[] => {
  const out: E[] = []
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (rnd() > density) continue
    out.push({ userA: { id: `m${i}` }, userB: { id: `m${j}` }, mutualScore: Math.round(80 + rnd() * 240) })
  }
  return out
}

/**
 * THE BUG THIS PINS. The reduction kept each member's top-8 edges and then passed the result
 * straight to the search WITHOUT re-checking it against MAX_COMPONENT_EDGES. On a 116-member
 * graph that produced ~550 edges against a declared cap of 220 — the cap was reported as
 * enforced (exact:false, reason:'component_edge_cap') and never actually met.
 */
describe('component edge cap is actually enforced, not just reported', () => {
  it('a component far over the cap is reduced to AT OR UNDER it', () => {
    const edges = graph(116, 0.72)
    expect(edges.length).toBeGreaterThan(3000)          // well over any cap
    const r = reduceComponentToCap(edges, 2500)
    expect(r.reduced).toBe(true)
    expect(r.edges.length).toBeLessThanOrEqual(2500)    // ← the invariant that was violated
  })

  it('the old fixed-K=8 behaviour would have BREACHED a 220 cap — regression witness', () => {
    const edges = graph(116, 0.72)
    const fixedK8 = reduceComponentToCap(edges, /* cap */ 1, /* maxK */ 8, /* minK */ 8)
    expect(fixedK8.edges.length).toBeGreaterThan(220)   // what shipped: ~550 through a 220 cap
    const honest = reduceComponentToCap(edges, 220)     // same graph, iterating K
    expect(honest.edges.length).toBeLessThanOrEqual(220)
  })

  it('K halves from 32 until it fits, and the chosen K is reported', () => {
    const r = reduceComponentToCap(graph(116, 0.72), 2500)
    expect([32, 16, 8, 4, 2, 1]).toContain(r.k)
    expect(r.edges.length).toBeLessThanOrEqual(2500)
  })

  it('holds at 500 members, where a FIXED K=32 produced 8,781 edges and never completed', () => {
    const r = reduceComponentToCap(graph(500, 0.17), 2500)
    expect(r.edges.length).toBeLessThanOrEqual(2500)
    expect(r.k).toBeLessThan(32)                        // it had to step down — that is the point
  })

  it('never strands a member: at any K every member keeps at least one edge', () => {
    const edges = graph(116, 0.72)
    const ids = new Set<string>()
    for (const e of edges) { ids.add(e.userA.id); ids.add(e.userB.id) }
    const kept = new Set<string>()
    for (const e of reduceComponentToCap(edges, 300).edges) { kept.add(e.userA.id); kept.add(e.userB.id) }
    expect(kept.size).toBe(ids.size)
  })

  it('a component already under the cap is returned untouched', () => {
    const edges = graph(20, 0.5)
    const r = reduceComponentToCap(edges, 2500)
    expect(r.reduced).toBe(false)
    expect(r.edges).toBe(edges)
  })

  it('the reduction is deterministic — same input, same output', () => {
    const edges = graph(116, 0.72)
    const a = reduceComponentToCap(edges, 2500)
    const b = reduceComponentToCap(edges.slice(), 2500)   // same edges, fresh array
    expect(a.k).toBe(b.k)
    expect(a.edges.length).toBe(b.edges.length)
    const key = (e: any) => `${e.userA.id}|${e.userB.id}`
    expect(a.edges.map(key)).toEqual(b.edges.map(key))
  })

  // ── End to end, and the runtime claim that motivated the budget change. ──
  it('solve completes fast and seats nearly everyone at 116 members', () => {
    const edges = graph(116, 0.72)
    const ids = Array.from(new Set(edges.flatMap(e => [e.userA.id, e.userB.id])))
    const t0 = Date.now()
    const r = solveGlobalBMatching(edges as any[], {
      capacityByMember: new Map(ids.map(i => [i, 2])),
      existingVisibleByMember: new Map(ids.map(i => [i, 0])),
    } as any)
    expect(Date.now() - t0).toBeLessThan(5000)          // was ~4s of pure search for a worse answer
    let atTwo = 0
    for (const i of ids) if ((r.degree.get(i) ?? 0) >= 2) atTwo++
    expect(atTwo / ids.length).toBeGreaterThan(0.9)     // K=8 previously left ~10 members short
  })

  it('the constants carry their measurements', () => {
    expect(SRC).toMatch(/const DEFAULT_NODE_BUDGET = 2_000_000/)
    expect(SRC).toMatch(/const MAX_COMPONENT_EDGES = 2_500/)
    expect(SRC).toMatch(/const TOP_K_PER_MEMBER_MAX = 32/)
    expect(SRC).toMatch(/KEPT AT 2,000,000 AFTER MEASUREMENT/)
    expect(SRC).toMatch(/does not complete AT ALL/)
    expect(SRC).not.toMatch(/const TOP_K_PER_MEMBER = /)   // the fixed constant is gone
  })
})
