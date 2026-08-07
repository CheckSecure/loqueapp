import { describe, it, expect } from 'vitest'
import { preferCrossMarketForPartners } from '@/lib/matching/reciprocal-graph'

/**
 * PART 8 — bounded cross-market-first swap for Law Firm Partners (System B).
 * Small hand-built graphs exercise each safety rule deterministically.
 */
const M = (id: string, role: string) => ({ id, role_type: role })
const E = (a: any, b: any, s = 100) => ({ userA: a, userB: b, scoreAtoB: s / 2, scoreBtoA: s / 2, mutualScore: s })
const cfg = (over: any = {}) => ({
  capOf: () => 2,
  isPartner: (m: any) => m.role_type === 'partner',
  isPartnerPair: (a: any, b: any) => a.role_type === 'partner' && b.role_type === 'partner',
  minCoverage: 1,
  maxSacrifice: 1000,
  ...over,
})
const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
const has = (edges: any[], a: string, b: string) => edges.some((e) => key(e.userA.id, e.userB.id) === key(a, b))
const deg = (edges: any[], id: string) => edges.filter((e) => e.userA.id === id || e.userB.id === id).length
const noneAtZero = (edges: any[], ids: string[]) => ids.every((id) => deg(edges, id) >= 1)

const P = M('P', 'partner')
const G1 = M('G1', 'gc'), G2 = M('G2', 'gc'), G = M('G', 'gc')
const X = M('X', 'coo'), Y = M('Y', 'cfo'), R = M('R', 'vp')

describe('preferCrossMarketForPartners', () => {
  it('1. partner with 2 FREE cross-market candidates → seats 2 cross-market', () => {
    const { edges } = preferCrossMarketForPartners([], [E(P, G1, 100), E(P, G2, 90)], cfg())
    expect(deg(edges, 'P')).toBe(2)
    expect(has(edges, 'P', 'G1') && has(edges, 'P', 'G2')).toBe(true)
  })

  it('2/4/8. saturated preferred candidate → bounded swap displaces the WEAKEST edge and re-seats the displaced member', () => {
    const selected = [E(G, X, 50), E(G, Y, 120)]                 // G at cap; X weakest
    const edges = [...selected, E(P, G, 80), E(X, R, 60)]        // X can be re-seated with free R
    const { edges: out, swaps } = preferCrossMarketForPartners(selected, edges, cfg())
    expect(has(out, 'P', 'G')).toBe(true)      // partner seated cross-market
    expect(has(out, 'G', 'X')).toBe(false)     // weakest displaced
    expect(has(out, 'G', 'Y')).toBe(true)      // strong edge preserved
    expect(has(out, 'X', 'R')).toBe(true)      // displaced member re-seated
    expect(noneAtZero(out, ['P', 'G', 'X', 'Y', 'R'])).toBe(true)
    expect(swaps[0].displaced).toBe('X'); expect(swaps[0].reseated).toBe('R')
  })

  it('3. swap that would drop a displaced member (at 1, no re-seat) to 0 → FORBIDDEN', () => {
    const selected = [E(G, X, 50), E(G, Y, 120)]                 // X at 1, only via G
    const edges = [...selected, E(P, G, 80)]                     // no X re-seat edge
    const { edges: out } = preferCrossMarketForPartners(selected, edges, cfg())
    expect(has(out, 'P', 'G')).toBe(false)     // no swap
    expect(has(out, 'G', 'X')).toBe(true)      // X preserved at 1
    expect(noneAtZero(out, ['X', 'Y'])).toBe(true)
  })

  it('5. swap whose quality loss exceeds maxSacrifice → FORBIDDEN', () => {
    const selected = [E(G, X, 120), E(G, Y, 110)]               // displacing G-X loses 120
    const edges = [...selected, E(P, G, 50), E(X, R, 40)]       // delta = 50+40-120 = -30
    expect(has(preferCrossMarketForPartners(selected, edges, cfg({ maxSacrifice: 10 })).edges, 'P', 'G')).toBe(false)
    expect(has(preferCrossMarketForPartners(selected, edges, cfg({ maxSacrifice: 40 })).edges, 'P', 'G')).toBe(true)
  })

  it('5b. NEVER displaces another partner to seat P (no cascade)', () => {
    const P2 = M('P2', 'partner')
    // G is matched to partner P2 (weakest) + Y; Y has no re-seat. To seat P-G we could only
    // displace G-P2 (weakest) — but P2 is a partner, so it must be skipped, leaving no move.
    const selected = [E(G, P2, 50), E(G, Y, 120)]
    const edges = [...selected, E(P, G, 80)]   // no re-seat edge for anyone
    const { edges: out } = preferCrossMarketForPartners(selected, edges, cfg())
    expect(has(out, 'P', 'G')).toBe(false)     // P NOT seated by cascading a partner
    expect(has(out, 'G', 'P2')).toBe(true)     // partner P2's edge untouched
    expect(deg(out, 'P2')).toBe(1)             // P2 not dropped
  })

  it('6. only ONE safely seatable cross-market → seats 1, leaves slot 2 open (for same-side fallback)', () => {
    const selected = [E(G2, X, 120), E(G2, Y, 110)]           // G2 saturated, X/Y at 1, no re-seat
    const edges = [E(P, G1, 100), E(P, G2, 90), ...selected]  // G1 free, G2 unswappable
    const { edges: out } = preferCrossMarketForPartners(selected, edges, cfg())
    expect(deg(out, 'P')).toBe(1)
    expect(has(out, 'P', 'G1')).toBe(true)
  })

  it('7. no safely seatable cross-market → no swap (slots stay open)', () => {
    const selected = [E(G, X, 120), E(G, Y, 110)]
    const { edges: out } = preferCrossMarketForPartners(selected, [E(P, G, 90), ...selected], cfg())
    expect(deg(out, 'P')).toBe(0)
  })

  it('9. a NON-law-firm recipient is unaffected (only partners are filled here)', () => {
    const gcRecipient = M('GCR', 'gc')
    const { edges: out } = preferCrossMarketForPartners([], [E(gcRecipient, G1, 100)], cfg())
    expect(deg(out, 'GCR')).toBe(0) // this pass fills partners only; GCR handled by normal fill
  })

  it('10. no member is ever driven to 0 intros by a swap', () => {
    const selected = [E(G, X, 50), E(G, Y, 120)]
    const edges = [...selected, E(P, G, 80), E(X, R, 60)]
    const { edges: out } = preferCrossMarketForPartners(selected, edges, cfg())
    expect(noneAtZero(out, ['P', 'G', 'X', 'Y', 'R'])).toBe(true)
  })
})
