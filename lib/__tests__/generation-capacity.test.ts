import { describe, it, expect } from 'vitest'
import { solveGlobalBMatching } from '@/lib/matching/globalBMatching'
import { validateGeneration, visibleDeficit } from '@/lib/matching/generationInvariants'

/**
 * THE PRODUCTION FAILURE, reproduced exactly.
 *
 * Review batch 4 was generated with 5 pairs whose BOTH members were already full and 17 more with
 * one full member; 16 already-full members were included. The timing audit ruled out staleness: no
 * visible row was created or changed after generation.
 *
 * The cause was arithmetic, not timing. The deficit handed to the optimizer was
 *     min(tierLimit, visibleFree + reservedFree)
 * while migration 064 places pairs into the VISIBLE tier only. A member holding 2 visible and 0
 * reserved cards scored visibleFree 0 + reservedFree 2 = deficit 2, and entered the graph as though
 * their screen were empty. A second, latent fault compounded it: capacity was derived from an
 * unbounded `intro_requests` select with `?? 0` for a missing member, so a member outside the
 * returned window also read as holding zero cards.
 *
 * These are behavioural tests against the real solver and the real validator.
 */

type M = { id: string; role_type?: string | null }
const m = (id: string): M => ({ id })
const edge = (a: M, b: M, score = 100) => ({ userA: a, userB: b, mutualScore: score })
const MAX = 2

/** Build the strict maps the way the corrected route does: visible-only, explicit for everyone. */
const snapshot = (visibleByMember: Map<string, number>) => ({
  capacityByMember: new Map(Array.from(visibleByMember, ([id, v]) => [id, visibleDeficit(v, MAX)])),
  existingVisibleByMember: visibleByMember,
})
const degOf = (r: { degree: Map<string, number> }, id: string) => r.degree.get(id) ?? 0
const fanOut = (sel: ReadonlyArray<{ userA: M; userB: M }>) =>
  sel.flatMap((e) => [
    { recipient_id: e.userA.id, suggested_id: e.userB.id },
    { recipient_id: e.userB.id, suggested_id: e.userA.id },
  ])

describe('production shape: 98 eligible — 72 full, 14 at one card, 12 empty', () => {
  const ids: string[] = []
  const visible = new Map<string, number>()
  for (let i = 0; i < 98; i++) {
    const id = 'U' + String(i).padStart(3, '0')
    ids.push(id)
    visible.set(id, i < 72 ? 2 : i < 86 ? 1 : 0)   // 72 full, 14 one-card, 12 zero-card
  }
  const members = new Map(ids.map((i) => [i, m(i)]))
  // A dense graph in which the FULL members carry the highest scores, so nothing but capacity can
  // keep them out. This is the exact trap the old deficit fell into.
  const edges: any[] = []
  for (let i = 0; i < 98; i++) {
    for (let j = i + 1; j < 98; j++) {
      if ((i * 31 + j * 17) % 7 >= 2) continue
      const bothFull = i < 72 && j < 72
      edges.push(edge(members.get(ids[i])!, members.get(ids[j])!, bothFull ? 400 : 90))
    }
  }
  const snap = snapshot(visible)
  const r = solveGlobalBMatching(edges, snap)
  const full = ids.filter((i) => visible.get(i) === 2)
  const one = ids.filter((i) => visible.get(i) === 1)
  const zero = ids.filter((i) => visible.get(i) === 0)

  it('72 already-full members appear in NO selected edge', () => {
    expect(full).toHaveLength(72)
    const touched = full.filter((i) => degOf(r, i) > 0)
    expect(touched, `${touched.length} full members were selected`).toHaveLength(0)
  })

  it('every one-card member receives at most ONE edge', () => {
    expect(one).toHaveLength(14)
    for (const i of one) expect(degOf(r, i)).toBeLessThanOrEqual(1)
  })

  it('every zero-card member receives at most TWO edges', () => {
    expect(zero).toHaveLength(12)
    for (const i of zero) expect(degOf(r, i)).toBeLessThanOrEqual(2)
  })

  it('both endpoints of every selected edge have visible capacity', () => {
    for (const e of r.selected) {
      expect(visible.get(e.userA.id)!).toBeLessThan(MAX)
      expect(visible.get(e.userB.id)!).toBeLessThan(MAX)
    }
  })

  it('no member is projected above two visible cards', () => {
    for (const i of ids) expect(visible.get(i)! + degOf(r, i)).toBeLessThanOrEqual(MAX)
  })

  it('proposals are exactly symmetric and the validator passes', () => {
    const rows = fanOut(r.selected)
    expect(rows).toHaveLength(r.selected.length * 2)
    const v = validateGeneration(r.selected, { visibleByMember: visible, maxVisible: MAX }, rows)
    expect(v.violations).toEqual({})
    expect(v.ok).toBe(true)
  })

  it('the OLD deficit formula would have failed this very validator', () => {
    // visibleFree + reservedFree, with everyone holding 0 reserved cards → deficit 2 for all.
    const bad = solveGlobalBMatching(edges, {
      capacityByMember: new Map(ids.map((i) => [i, Math.min(2, visibleDeficit(visible.get(i)!, MAX) + 2)])),
      existingVisibleByMember: visible,
    })
    const v = validateGeneration(bad.selected, { visibleByMember: visible, maxVisible: MAX }, fanOut(bad.selected))
    expect(v.ok, 'the old formula must be caught, not silently written').toBe(false)
    expect(v.violations.member_already_full).toBeGreaterThan(0)
  })
})

describe('focused capacity cases', () => {
  it('1. a full member with the highest-quality edges is still excluded', () => {
    const F = m('F'), X = m('X'), Y = m('Y')
    const visible = new Map([['F', 2], ['X', 0], ['Y', 0]])
    const r = solveGlobalBMatching([edge(F, X, 999), edge(F, Y, 999), edge(X, Y, 10)], snapshot(visible))
    expect(degOf(r, 'F')).toBe(0)
    expect(degOf(r, 'X')).toBe(1)
    expect(degOf(r, 'Y')).toBe(1)
  })

  it('2. a MISSING capacity entry throws — it never defaults to two', () => {
    const A = m('A'), B = m('B')
    expect(() => solveGlobalBMatching([edge(A, B)], {
      capacityByMember: new Map([['A', 2]]),               // B absent
      existingVisibleByMember: new Map([['A', 0], ['B', 0]]),
    })).toThrow(/capacity_missing_for_member/)
  })

  it('2b. negative or non-integer capacity is rejected', () => {
    const A = m('A'), B = m('B')
    for (const bad of [-1, 1.5, NaN]) {
      expect(() => solveGlobalBMatching([edge(A, B)], {
        capacityByMember: new Map([['A', bad], ['B', 2]]),
        existingVisibleByMember: new Map([['A', 0], ['B', 0]]),
      })).toThrow(/capacity_invalid_for_member/)
    }
  })

  it('5. a one-card member with many strong candidates gets exactly one edge', () => {
    const O = m('O')
    const others = ['a', 'b', 'c', 'd', 'e'].map(m)
    const visible = new Map<string, number>([['O', 1], ...others.map((x) => [x.id, 0] as [string, number])])
    const r = solveGlobalBMatching(others.map((x) => edge(O, x, 300)), snapshot(visible))
    expect(degOf(r, 'O')).toBe(1)
  })

  it('6. a zero-card member with many strong candidates gets at most two', () => {
    const Z = m('Z')
    const others = ['a', 'b', 'c', 'd', 'e'].map(m)
    const visible = new Map<string, number>([['Z', 0], ...others.map((x) => [x.id, 0] as [string, number])])
    const r = solveGlobalBMatching(others.map((x) => edge(Z, x, 300)), snapshot(visible))
    expect(degOf(r, 'Z')).toBe(2)
  })

  it('7. all candidates full → zero pairs, an honest empty result', () => {
    const A = m('A'), B = m('B'), C = m('C')
    const visible = new Map([['A', 2], ['B', 2], ['C', 2]])
    const r = solveGlobalBMatching([edge(A, B, 500), edge(B, C, 500), edge(A, C, 500)], snapshot(visible))
    expect(r.selected).toHaveLength(0)
    const v = validateGeneration(r.selected, { visibleByMember: visible, maxVisible: MAX }, [])
    expect(v.ok).toBe(true)
  })

  it('8. one valid underfilled pair among many full high-score candidates is found', () => {
    const F1 = m('F1'), F2 = m('F2'), F3 = m('F3'), U1 = m('U1'), U2 = m('U2')
    const visible = new Map([['F1', 2], ['F2', 2], ['F3', 2], ['U1', 0], ['U2', 0]])
    const r = solveGlobalBMatching(
      [edge(F1, F2, 900), edge(F2, F3, 900), edge(F1, F3, 900), edge(F1, U1, 800), edge(U1, U2, 45)],
      snapshot(visible))
    expect(r.selected).toHaveLength(1)
    expect(degOf(r, 'U1')).toBe(1)
    expect(degOf(r, 'U2')).toBe(1)
  })

  it('9. symmetric expansion cannot increase degree', () => {
    const A = m('A'), B = m('B'), C = m('C')
    const visible = new Map([['A', 0], ['B', 1], ['C', 1]])
    const r = solveGlobalBMatching([edge(A, B), edge(A, C), edge(B, C)], snapshot(visible))
    const rows = fanOut(r.selected)
    const perRecipient = new Map<string, number>()
    for (const row of rows) perRecipient.set(row.recipient_id, (perRecipient.get(row.recipient_id) ?? 0) + 1)
    for (const [id, n] of Array.from(perRecipient.entries())) {
      expect(n, `${id} got more rows than edges`).toBe(degOf(r, id))
      expect(visible.get(id)! + n).toBeLessThanOrEqual(MAX)
    }
  })
})

describe('the pre-write validator catches a corrupted solver result', () => {
  const visible = new Map([['A', 2], ['B', 0], ['C', 0], ['D', 0]])
  const A = m('A'), B = m('B'), C = m('C'), D = m('D')
  const snap = { visibleByMember: visible, maxVisible: MAX }

  it('10. rejects a full member smuggled into the result', () => {
    const bad = [{ userA: A, userB: B }]
    const v = validateGeneration(bad, snap, fanOut(bad))
    expect(v.ok).toBe(false)
    expect(v.violations.member_already_full).toBe(1)
    expect(v.violations.member_degree_exceeds_deficit).toBe(1)
  })

  it('rejects a degree above the member deficit', () => {
    const bad = [{ userA: B, userB: C }, { userA: B, userB: D }, { userA: B, userB: A }]
    const v = validateGeneration(bad, snap, fanOut(bad))
    expect(v.ok).toBe(false)
    expect(v.violations.member_degree_exceeds_deficit).toBeGreaterThan(0)
  })

  it('rejects a member missing from the snapshot', () => {
    const Z = m('Z')
    const bad = [{ userA: B, userB: Z }]
    const v = validateGeneration(bad, snap, fanOut(bad))
    expect(v.ok).toBe(false)
    expect(v.violations.member_missing_from_capacity_snapshot).toBe(1)
  })

  it('rejects self-pairs and duplicate unordered pairs', () => {
    const selfp = [{ userA: B, userB: B }]
    expect(validateGeneration(selfp, snap, []).violations.self_pair).toBe(1)
    const dup = [{ userA: B, userB: C }, { userA: C, userB: B }]
    expect(validateGeneration(dup, snap, fanOut([{ userA: B, userB: C }])).violations.duplicate_unordered_pair).toBe(1)
  })

  it('rejects an asymmetric or mis-counted fan-out', () => {
    const sel = [{ userA: B, userB: C }]
    const oneSided = [{ recipient_id: 'B', suggested_id: 'C' }]
    const v = validateGeneration(sel, snap, oneSided)
    expect(v.ok).toBe(false)
    expect(v.violations.directional_rows_mismatch).toBe(1)
    expect(v.violations.asymmetric_proposal_rows).toBe(1)
  })

  it('reports aggregate counts only — no identity ever appears', () => {
    const bad = [{ userA: A, userB: B }, { userA: m('Z'), userB: C }]
    const blob = JSON.stringify(validateGeneration(bad, snap, fanOut(bad)))
    for (const leak of ['"A"', '"B"', '"C"', '"Z"', '@']) expect(blob).not.toContain(leak)
  })
})

describe('bounded fallback preserves the same degree limits', () => {
  it('exact:false output still respects every capacity', () => {
    const ids = Array.from({ length: 40 }, (_, i) => 'L' + String(i).padStart(2, '0'))
    const visible = new Map(ids.map((id, i) => [id, (i % 3 === 0 ? 1 : 0)] as [string, number]))
    const mem = new Map(ids.map((i) => [i, m(i)]))
    const edges: any[] = []
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++)
      if ((i * 7 + j * 3) % 4 === 0) edges.push(edge(mem.get(ids[i])!, mem.get(ids[j])!, 60 + ((i + j) % 40)))
    const r = solveGlobalBMatching(edges, { ...snapshot(visible), nodeBudget: 500 })
    for (const id of ids) expect(visible.get(id)! + degOf(r, id)).toBeLessThanOrEqual(MAX)
    const v = validateGeneration(r.selected, { visibleByMember: visible, maxVisible: MAX }, fanOut(r.selected))
    expect(v.ok, 'a bounded fallback must still be writable').toBe(true)
  })
})
