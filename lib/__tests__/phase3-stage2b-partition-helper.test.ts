import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  partitionByCommunity,
  countUnknownCommunity,
  MEMBER_TYPES,
} from '@/lib/community/memberType'

/**
 * PHASE 3 STAGE 2B, COMMIT 1 — the cohort partition helper.
 *
 * The Admin/Thursday batch has no viewer, so Stage 2A's filterSameCommunity does not apply: there
 * is nobody to filter against. It needs the cohort SPLIT before scoring, because two separate
 * channels otherwise let one community change the other's Professional↔Professional results:
 *
 *   1. buildScoringContext's memberCount is the IDF denominator — log((N+1)/(df+1))/log(N+1).
 *   2. solveGlobalBMatching's reduceComponent halves top-k until a component fits
 *      MAX_COMPONENT_EDGES, so a larger mixed component reduces Professional edges harder.
 *
 * These tests pin the helper's contract. The partition's EFFECT on the generator is proven in
 * phase3-stage2b-batch-partition.test.ts.
 */

const member = (id: string, member_type: unknown) => ({ id, member_type } as any)
const PRO = (id: string) => member(id, 'professional')
const NEXT = (id: string) => member(id, 'next')

describe('partitionByCommunity — order is preserved exactly', () => {
  it('Professional order survives element for element', () => {
    const rows = [PRO('a'), NEXT('x'), PRO('b'), NEXT('y'), PRO('c')]
    expect(partitionByCommunity(rows).get('professional')!.map((r: any) => r.id))
      .toEqual(['a', 'b', 'c'])
  })

  it('Next order survives element for element', () => {
    const rows = [NEXT('x'), PRO('a'), NEXT('y'), PRO('b'), NEXT('z')]
    expect(partitionByCommunity(rows).get('next')!.map((r: any) => r.id))
      .toEqual(['x', 'y', 'z'])
  })

  it('an all-Professional cohort partitions to the SAME OBJECTS in the same order', () => {
    // This is the equivalence guarantee the whole of Stage 2B rests on: the batch generator builds
    // pairs with a nested i<j loop and then sorts with a comparator that can return 0, so ties fall
    // through to sort stability — i.e. to this array's order. Identity, not just equality.
    const rows = [PRO('a'), PRO('b'), PRO('c'), PRO('d'), PRO('e')]
    const pro = partitionByCommunity(rows).get('professional')!
    expect(pro).toEqual(rows)
    pro.forEach((r: any, i: number) => expect(r).toBe(rows[i]))
    expect(partitionByCommunity(rows).get('next')).toEqual([])
  })

  it('a 200-row interleaved cohort keeps both orders exactly', () => {
    const rows = Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? NEXT(`n${i}`) : PRO(`p${i}`)))
    const m = partitionByCommunity(rows)
    expect(m.get('professional')!.map((r: any) => r.id))
      .toEqual(rows.filter((r: any) => r.member_type === 'professional').map((r: any) => r.id))
    expect(m.get('next')!.map((r: any) => r.id))
      .toEqual(rows.filter((r: any) => r.member_type === 'next').map((r: any) => r.id))
  })
})

describe('partitionByCommunity — unknown communities enter NEITHER partition', () => {
  const BAD: unknown[] = [null, undefined, '', 'Professional', 'NEXT', 'professsional', 'student',
                          0, 1, true, {}, [], 'PROFESSIONAL ']

  it('every malformed value is dropped, never defaulted to professional', () => {
    for (const bad of BAD) {
      const rows = [PRO('good'), member('bad', bad), NEXT('ngood')]
      const m = partitionByCommunity(rows)
      expect(m.get('professional')!.map((r: any) => r.id), JSON.stringify(bad)).toEqual(['good'])
      expect(m.get('next')!.map((r: any) => r.id), JSON.stringify(bad)).toEqual(['ngood'])
    }
  })

  it('a row with no member_type key at all is dropped', () => {
    expect(partitionByCommunity([{ id: 'x' } as any]).get('professional')).toEqual([])
    expect(partitionByCommunity([{ id: 'x' } as any]).get('next')).toEqual([])
  })

  it('countUnknownCommunity counts exactly those rows', () => {
    const rows = [PRO('a'), member('b', null), NEXT('c'), member('d', 'oops'), { id: 'e' } as any]
    expect(countUnknownCommunity(rows)).toBe(3)
    const m = partitionByCommunity(rows)
    expect(m.get('professional')!.length + m.get('next')!.length + countUnknownCommunity(rows))
      .toBe(rows.length)
  })

  it('null/undefined input is an empty partition, not a throw', () => {
    for (const input of [null, undefined, []] as const) {
      const m = partitionByCommunity(input as any)
      expect(m.get('professional')).toEqual([])
      expect(m.get('next')).toEqual([])
    }
    expect(countUnknownCommunity(null)).toBe(0)
  })
})

describe('partitionByCommunity — shape and exceptions', () => {
  it('every community is always a key, so a small cohort is a natural no-op', () => {
    const m = partitionByCommunity([PRO('a')])
    expect(Array.from(m.keys()).sort()).toEqual([...MEMBER_TYPES].sort())
    // A partition with fewer than 2 members yields no pairs downstream; it is not an error.
    expect(m.get('next')).toEqual([])
    expect(m.get('professional')!.length).toBe(1)
  })

  it('the partitions are disjoint and lose nothing recognised', () => {
    const rows = [PRO('a'), NEXT('x'), PRO('b'), member('u', null)]
    const m = partitionByCommunity(rows)
    const ids = [...m.get('professional')!, ...m.get('next')!].map((r: any) => r.id)
    expect(new Set(ids).size).toBe(ids.length)   // disjoint
    expect(ids.sort()).toEqual(['a', 'b', 'x'])  // every recognised row placed
  })

  it('it reuses communityOf — there is no second definition of Professional/Next', () => {
    const src = readFileSync('lib/community/memberType.ts', 'utf8')
    const from = src.indexOf('export function partitionByCommunity')
    const body = src.slice(from, src.indexOf('\n}', from))
    const code = body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(code).toContain('communityOf(')
    // No inline string comparison would be a second, drift-prone definition of the rule.
    expect(code).not.toMatch(/'professional'|'next'|"professional"|"next"/)
  })

  it('has NO mentorship and NO recruiting/hiring exception', () => {
    const src = readFileSync('lib/community/memberType.ts', 'utf8')
    const from = src.indexOf('export function partitionByCommunity')
    const body = src.slice(from, src.indexOf('\n}', from))
    const code = body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/mentor|recruit|hiring|bridge|bypass|allowCross/i)
    // Behavioural: a Professional flagged for every future bridge still never lands in `next`.
    const flagged = { id: 'p', member_type: 'professional', open_to_next_mentorship: true,
                      recruiter: true, open_to_roles: true } as any
    expect(partitionByCommunity([flagged]).get('next')).toEqual([])
    expect(partitionByCommunity([flagged]).get('professional')!.map((r: any) => r.id)).toEqual(['p'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('COMMIT 2 — Pool 3 loads member_type, and only internally', () => {
  const ROUTE = readFileSync('app/api/admin/generate-batch/route.ts', 'utf8')

  it('the batch profile select names the shared column constant', () => {
    const sel = ROUTE.slice(ROUTE.indexOf("from('profiles')"), ROUTE.indexOf('const profiles ='))
    expect(sel).toContain('${MEMBER_TYPE_COLUMNS}')
    expect(ROUTE).toMatch(/import \{ MEMBER_TYPE_COLUMNS \} from '@\/lib\/community\/memberType'/)
  })

  it('it still selects an explicit column list, not select(*)', () => {
    // A widened select would pull columns this route has no business reading.
    const sel = ROUTE.slice(ROUTE.indexOf("from('profiles')"), ROUTE.indexOf('const profiles ='))
    expect(sel).not.toMatch(/\.select\('\*'\)/)
    expect(sel).toContain('${ELIGIBILITY_COLUMNS}')
  })

  it('member_type is never written to batch_suggestions', () => {
    const rows = ROUTE.slice(ROUTE.indexOf('allSuggestions.push({'), ROUTE.indexOf('const invariants'))
    expect(rows).not.toContain('member_type')
    for (const col of ['batch_id', 'recipient_id', 'suggested_id', 'reason', 'match_score',
                       'score_bucket', 'position', 'status']) {
      expect(rows, col).toContain(col)
    }
  })

  it('the public profile surface is untouched', () => {
    expect(readFileSync('lib/profiles/publicProfile.ts', 'utf8')).not.toContain('member_type')
  })
})
