import { describe, it, expect } from 'vitest'
import { repairOneIntroCoverage } from '@/lib/matching/reciprocal-graph'

// Minimal edge/member fixtures. role_type drives partner/provider predicates.
const m = (id: string, role = 'Founder') => ({ id, role_type: role })
const edge = (a: any, b: any, score = 100) => ({ userA: a, userB: b, scoreAtoB: score / 2, scoreBtoA: score / 2, mutualScore: score })
const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
const has = (edges: any[], x: string, y: string) => edges.some((e) => key(e.userA.id, e.userB.id) === key(x, y))
const deg = (edges: any[], id: string) => edges.filter((e) => e.userA.id === id || e.userB.id === id).length
const cfg = (over: any = {}) => ({ capOf: () => 2, isPartnerPair: (a: any, b: any) => a.role_type === 'Law Firm Partner' && b.role_type === 'Law Firm Partner', ...over })

describe('repairOneIntroCoverage', () => {
  it('1) seats a 1-intro member via a length-3 swap; displaced member is re-seated', () => {
    // u@1 (—A). P saturated (—Q, —Bx). Q@2 (—P, —C). R has spare capacity, eligible to Q.
    const [u, A, P, Bx, Q, C, R] = ['u', 'A', 'P', 'Bx', 'Q', 'C', 'R'].map((id) => m(id))
    const selected = [edge(u, A), edge(P, Q, 90), edge(P, Bx), edge(Q, C)]
    const eligible = [...selected, edge(u, P, 80), edge(Q, R, 70)]
    const out = repairOneIntroCoverage(selected, eligible, cfg())

    expect(deg(out, 'u')).toBe(2)          // u gained a 2nd intro
    expect(has(out, 'u', 'P')).toBe(true)  // via P
    expect(has(out, 'Q', 'R')).toBe(true)  // Q re-seated with R
    expect(has(out, 'P', 'Q')).toBe(false) // the displaced edge is gone
    expect(deg(out, 'Q')).toBe(2)          // displaced member did NOT fall below 2
    expect(deg(out, 'P')).toBe(2)          // P unchanged
    expect(deg(out, 'R')).toBe(1)          // R lifted (0 → 1)
  })

  it('2) never exceeds 2 intros for any member after repair', () => {
    const [u, A, P, Bx, Q, C, R] = ['u', 'A', 'P', 'Bx', 'Q', 'C', 'R'].map((id) => m(id))
    const selected = [edge(u, A), edge(P, Q), edge(P, Bx), edge(Q, C)]
    const eligible = [...selected, edge(u, P), edge(Q, R)]
    const out = repairOneIntroCoverage(selected, eligible, cfg())
    const ids = ['u', 'A', 'P', 'Bx', 'Q', 'C', 'R']
    for (const id of ids) expect(deg(out, id)).toBeLessThanOrEqual(2)
  })

  it('3) does NOT create a partner↔partner edge (partner count never increases)', () => {
    // u is a Law Firm Partner whose only route to a 2nd intro is another partner P.
    const u = m('u', 'Law Firm Partner')
    const A = m('A', 'General Counsel')
    const P = m('P', 'Law Firm Partner')
    const Q = m('Q', 'General Counsel')
    const Bx = m('Bx', 'In-House Counsel')
    const selected = [edge(u, A), edge(P, Q), edge(P, Bx)]        // u@1; P saturated
    const eligible = [...selected, edge(u, P)]                    // the only new option is u—P (partner pair)
    const isPP = (e: any) => e.userA.role_type === 'Law Firm Partner' && e.userB.role_type === 'Law Firm Partner'
    const before = selected.filter(isPP).length
    const out = repairOneIntroCoverage(selected, eligible, cfg())
    expect(out.filter(isPP).length).toBe(before) // unchanged
    expect(has(out, 'u', 'P')).toBe(false)        // forbidden partner edge NOT added
    expect(deg(out, 'u')).toBe(1)                 // u correctly stays at 1
  })

  it('4) a 1-intro member with no other eligible candidate is left unchanged', () => {
    const [u, A] = [m('u'), m('A')]
    const selected = [edge(u, A)]      // u@1, no other eligible edges
    const eligible = [...selected]
    const out = repairOneIntroCoverage(selected, eligible, cfg())
    expect(out.length).toBe(selected.length)
    expect(deg(out, 'u')).toBe(1)
  })

  it('respects the business-solution throttle when re-seating (no throttled add)', () => {
    // Re-seat target edge Q—R would be provider↔non-opted-buyer → blocked; no move applied.
    const u = m('u'); const A = m('A')
    const P = m('P'); const Bx = m('Bx'); const C = m('C')
    const Q = m('Q', 'Consultant')                 // provider
    const R = { id: 'R', role_type: 'Founder', open_to_business_solutions: false } // non-opted buyer
    const selected = [edge(u, A), edge(P, Q), edge(P, Bx), edge(Q, C)]
    const eligible = [...selected, edge(u, P), edge(Q, R)]
    const out = repairOneIntroCoverage(selected, eligible, cfg({
      isBusinessSolutionProvider: (x: any) => (x.role_type || '').toLowerCase().includes('consultant'),
      bsCapOf: (x: any) => (x.open_to_business_solutions ? 1 : 0),
    }))
    // Q—R is throttled (provider Q → non-opted buyer R, quota 0) → swap not applied.
    expect(has(out, 'Q', 'R')).toBe(false)
    expect(deg(out, 'u')).toBe(1)
  })
})
