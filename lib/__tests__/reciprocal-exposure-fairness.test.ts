import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { getActiveInboundExposure } from '@/lib/generate-recommendations'
import { selectFairCounterpart, selectFairCounterparts } from '@/lib/matching/reciprocalPair'
import {
  exposurePenalty, VISIBLE_PENALTY_PER_CARD, VISIBLE_PENALTY_CAP,
  RESERVED_PENALTY_PER_CARD, RESERVED_PENALTY_CAP, MAX_EXPOSURE_PENALTY,
  VISIBLE_STATUS, RESERVED_STATUS, MAX_VISIBLE_INTRO_CARDS, MAX_RESERVED_INTRO_CARDS,
} from '@/lib/introductions/capacity'
import { ACTIVE_STATUSES } from '@/lib/introRequests/history'
import { NO_EXPOSURE, type CardCounts } from '@/lib/introductions/capacity'
import {
  applyExposureBalancing, DEFAULT_EXPOSURE_BALANCING,
  exposurePenalty as balancerPenalty,
} from '@/lib/matching/exposure-balancing'

/**
 * Active inbound exposure: how many live cards currently present a candidate TO OTHER MEMBERS.
 *
 * WHAT WAS WRONG. The implementation required `batch_id && activeBatchIds.has(batch_id)`, but the
 * reciprocal RPC creates its pair cards with batch_id NULL on purpose (migration 050 step 8). Every
 * reciprocal card was therefore invisible to the fairness input, so as reciprocal generation became
 * the primary path the penalty increasingly computed 0 for everyone and ordering collapsed to raw
 * compatibility score. Measured on production before the fix: 145 of 153 suggested rows counted,
 * all 8 reciprocal rows ignored.
 *
 * SECOND DEFECT, fixed here too. The result was a single number, so 'suggested' (already on a
 * member's screen) and 'queued' (reserved, shown to nobody) were worth the same. With a 6-point cap
 * at 2 points per card, ANY member holding 3+ active cards landed on the same saturated penalty:
 * measured on production, 59% of candidates sat on just three distinct penalty levels, so the
 * penalty stopped discriminating exactly where concentration is worst. Exposure now carries both
 * signals and penalises them separately (visible 2 each capped 6, reserved 1 each capped 2).
 *
 * This is a RANKING input only. Capacity is a different contract, defined in
 * lib/introductions/capacity and enforced in the RPCs under the member advisory lock.
 */

const counts = (visible: number, reserved = 0) => ({ visible, reserved })

/** Minimal chainable stub matching the query the implementation builds. */
function client(rows: any[] | null, error: any = null) {
  const calls: any = { tables: [] as string[], statuses: null as any, targets: null as any }
  const chain: any = {
    select: () => chain,
    in: (col: string, vals: any[]) => {
      if (col === 'status') calls.statuses = vals
      if (col === 'target_user_id') calls.targets = vals
      return chain
    },
    eq: () => chain,
    then: (res: any) => Promise.resolve({ data: rows, error }).then(res),
  }
  return {
    calls,
    from: (t: string) => { calls.tables.push(t); return chain },
  } as any
}

const row = (target: string, extra: Record<string, unknown> = {}) =>
  ({ target_user_id: target, status: VISIBLE_STATUS, ...extra })

describe('exposure is keyed on target_user_id, not requester_id', () => {
  it('counts the member being SHOWN, never the member holding the card', async () => {
    // A→B and A→C: B and C are each being shown once; A is shown zero times.
    const c = client([row('B'), row('C')])
    const e = await getActiveInboundExposure(c)
    expect(e.get('B')).toEqual(counts(1))
    expect(e.get('C')).toEqual(counts(1))
    expect(e.get('A')).toBeUndefined()
  })

  it('selects only target_user_id and status — requester_id is never read', () => {
    const SRC = readFileSync('lib/generate-recommendations.ts', 'utf8')
    const fn = SRC.slice(SRC.indexOf('export async function getActiveInboundExposure'), SRC.indexOf('export async function rankCandidatesForUser'))
    expect(fn).toMatch(/\.select\('target_user_id, status'\)/)
    expect(fn).not.toMatch(/requester_id/)
  })
})

describe('which rows count', () => {
  it('A. a legacy active-batch card gives its target +1', async () => {
    const e = await getActiveInboundExposure(client([row('B', { batch_id: 'batch-1' })]))
    expect(e.get('B')).toEqual(counts(1))
  })

  it('B. a reciprocal pair counts each direction against its OWN target, never double', async () => {
    // the two directional rows of one pair: A→B and B→A, both batch_id NULL
    const e = await getActiveInboundExposure(client([
      row('B', { pair_id: 'pair-1', batch_id: null }),
      row('A', { pair_id: 'pair-1', batch_id: null }),
    ]))
    expect(e.get('B')).toEqual(counts(1))
    expect(e.get('A')).toEqual(counts(1))
  })

  it('C. a candidate in several distinct cards accrues one per card', async () => {
    const e = await getActiveInboundExposure(client([row('B'), row('B'), row('B')]))
    expect(e.get('B')).toEqual(counts(3))
  })

  it('D. queued rows count, but as RESERVED — never merged into the visible tier', async () => {
    const c = client([
      row('B', { status: RESERVED_STATUS }),
      row('B', { status: RESERVED_STATUS }),
      row('B', { status: VISIBLE_STATUS }),
    ])
    const e = await getActiveInboundExposure(c)
    expect(e.get('B')).toEqual(counts(1, 2))
    expect(c.calls.statuses).toEqual(expect.arrayContaining(['suggested', 'queued']))
    expect(Array.from(ACTIVE_STATUSES).sort()).toEqual(['queued', 'suggested'])
  })

  it('E. terminal statuses are excluded by the query itself', async () => {
    const c = client([])
    await getActiveInboundExposure(c)
    for (const terminal of ['pending', 'approved', 'passed', 'declined', 'rejected', 'expired', 'archived', 'hidden', 'hidden_permanent', 'matched']) {
      expect(c.calls.statuses).not.toContain(terminal)
    }
    // matches live in another table entirely and are never read here
    expect(c.calls.tables).toEqual(['intro_requests'])
  })

  it('F. legacy and reciprocal rows combine into one total', async () => {
    const e = await getActiveInboundExposure(client([
      row('B', { batch_id: 'batch-1', pair_id: null }),
      row('B', { batch_id: null, pair_id: 'pair-1' }),
    ]))
    expect(e.get('B')).toEqual(counts(2))
  })

  it('G. a row with neither batch_id nor pair_id still counts when it is active', async () => {
    // Approved definition: activeness is decided by status alone.
    const e = await getActiveInboundExposure(client([row('B', { batch_id: null, pair_id: null })]))
    expect(e.get('B')).toEqual(counts(1))
  })

  it('ignores rows with no target and returns an honest empty map', async () => {
    expect((await getActiveInboundExposure(client([{ target_user_id: null, status: VISIBLE_STATUS }]))).size).toBe(0)
    expect((await getActiveInboundExposure(client([]))).size).toBe(0)
  })
})

describe('H. exposure never confers eligibility', () => {
  it('produces only counts — no eligibility fields are read or returned', () => {
    const SRC = readFileSync('lib/generate-recommendations.ts', 'utf8')
    const fn = SRC.slice(SRC.indexOf('export async function getActiveInboundExposure'), SRC.indexOf('export async function rankCandidatesForUser'))
    for (const gate of ['account_status', 'is_test_account', 'is_admin', 'matching_paused', 'profile_complete']) {
      expect(fn).not.toContain(gate)
    }
    // eligibility remains the ranker's/RPC's job
    expect(SRC).toMatch(/isEligibleMember/)
  })

  it('an unknown candidate is simply 0, never negative or undefined-crashing', async () => {
    const e = await getActiveInboundExposure(client([row('B')]))
    expect(e.get('someone-not-shown')).toBeUndefined()
    expect(exposurePenalty(e.get('someone-not-shown') ?? counts(0))).toBe(0)
  })
})

describe('I. the penalty keeps the two tiers separate', () => {
  it('weights and caps are exactly the approved contract', () => {
    expect(VISIBLE_PENALTY_PER_CARD).toBe(2)
    expect(VISIBLE_PENALTY_CAP).toBe(6)
    expect(RESERVED_PENALTY_PER_CARD).toBe(1)
    expect(RESERVED_PENALTY_CAP).toBe(2)
    expect(MAX_EXPOSURE_PENALTY).toBe(8)
  })

  it('a visible card costs twice what a reserved one does — shown beats not-yet-shown', () => {
    expect(exposurePenalty(counts(1, 0))).toBe(2)
    expect(exposurePenalty(counts(0, 1))).toBe(1)
    expect(exposurePenalty(counts(1, 1))).toBe(3)
  })

  it('each tier caps independently and the total never exceeds 8', () => {
    expect(exposurePenalty(counts(99, 0))).toBe(6)   // visible cap alone
    expect(exposurePenalty(counts(0, 99))).toBe(2)   // reserved cap alone
    expect(exposurePenalty(counts(99, 99))).toBe(8)  // both, still bounded
    for (const [v, r] of [[0, 0], [1, 2], [3, 1], [7, 9], [50, 50]]) {
      expect(exposurePenalty(counts(v, r))).toBeLessThanOrEqual(MAX_EXPOSURE_PENALTY)
    }
  })

  it('THE SATURATION BUG: 3 visible and 3 visible+2 reserved are no longer identical', () => {
    // Under the old single combined number both were min(6, n*2) = 6 and ranked equal, which is how
    // 59% of production candidates collapsed onto three levels. They must now differ.
    expect(exposurePenalty(counts(3, 0))).toBe(6)
    expect(exposurePenalty(counts(3, 2))).toBe(8)
    expect(exposurePenalty(counts(3, 0))).not.toBe(exposurePenalty(counts(3, 2)))
  })

  it('never negative, and defensive against malformed negative counts', () => {
    expect(exposurePenalty(counts(-5, -5))).toBe(0)
    expect(exposurePenalty(counts(0, 0))).toBe(0)
  })
})

describe('I2. ranking consumes the corrected exposure', () => {
  it('two equally-scored candidates order the LESS exposed first', () => {
    const picked = selectFairCounterparts([
      { id: 'high', score: 50, exposure: counts(3) },
      { id: 'low', score: 50, exposure: counts(0) },
    ], 2)
    expect(picked[0].id).toBe('low')
  })

  it('among equal scores, a reserved-only candidate outranks a visible-holding one', () => {
    // 50-1 = 49 beats 50-2 = 48: a card nobody has seen is a smaller claim on attention.
    const picked = selectFairCounterparts([
      { id: 'has-visible', score: 50, exposure: counts(1, 0) },
      { id: 'has-reserved', score: 50, exposure: counts(0, 1) },
    ], 2)
    expect(picked[0].id).toBe('has-reserved')
  })

  it('a materially better fit still wins despite maximum exposure — the penalty stays bounded', () => {
    const picked = selectFairCounterparts([
      { id: 'better-fit', score: 60, exposure: counts(99, 99) },
      { id: 'unexposed', score: 50, exposure: counts(0, 0) },
    ], 2)
    expect(picked[0].id).toBe('better-fit')
  })

  it('a candidate leading by more than 8 can never be displaced by exposure alone', () => {
    const picked = selectFairCounterparts([
      { id: 'a', score: 59, exposure: counts(100, 100) },
      { id: 'b', score: 50, exposure: counts(0, 0) },
    ], 2)
    expect(picked[0].id).toBe('a')
    // and one point under the cap it IS displaced — the bound is real, not decorative
    expect(selectFairCounterpart([
      { id: 'a', score: 57, exposure: counts(100, 100) },
      { id: 'b', score: 50, exposure: counts(0, 0) },
    ])!.id).toBe('b')
  })

  it('exact ties break toward the lighter load, weighting visible above reserved, then by id', () => {
    // equal penalty (both 2) but different composition: 1 visible vs 2 reserved
    expect(selectFairCounterpart([
      { id: 'z-visible', score: 50, exposure: counts(1, 0) },
      { id: 'a-reserved', score: 50, exposure: counts(0, 2) },
    ])!.id).toBe('a-reserved')
    // fully identical → deterministic id
    expect(selectFairCounterpart([
      { id: 'z', score: 50, exposure: counts(0, 0) },
      { id: 'a', score: 50, exposure: counts(0, 0) },
    ])!.id).toBe('a')
  })

  it('selection does not mutate the caller\'s exposure objects', () => {
    const shared = counts(1, 1)
    const input = [{ id: 'a', score: 50, exposure: shared }, { id: 'b', score: 40, exposure: counts(0) }]
    selectFairCounterparts(input, 2)
    expect(shared).toEqual({ visible: 1, reserved: 1 })
    expect(input[0].exposure).toBe(shared)
  })
})

describe('I3. the two consumers cannot be confused for one another', () => {
  const GEN = readFileSync('lib/generate-recommendations.ts', 'utf8')
  const BAL = readFileSync('lib/matching/exposure-balancing.ts', 'utf8')

  it('the formula is exactly the approved one, term by term', () => {
    for (const [v, r] of [[0, 0], [1, 0], [0, 1], [2, 1], [3, 3], [4, 0], [0, 5], [9, 9]]) {
      const expected = Math.min(6, v * 2) + Math.min(2, r * 1)
      expect(exposurePenalty(counts(v, r)), `visible=${v} reserved=${r}`).toBe(expected)
    }
  })

  it('the reciprocal ranker receives the OBJECT, with a zero-object default', () => {
    expect(GEN).toMatch(/exposure: exposure\.get\(c\.id\) \?\? NO_EXPOSURE/)
    // NO_EXPOSURE is an object, so an unseen candidate is {0,0} rather than undefined or 0
    expect(exposurePenalty(NO_EXPOSURE)).toBe(0)
    expect(NO_EXPOSURE).toEqual({ visible: 0, reserved: 0 })
  })

  it('the flag-gated balancer still receives NUMBERS, converted at the call site', () => {
    // It has its own tuning (softFloor 2, 1.5/unit, cap 6) built around one combined count, and is
    // deliberately unchanged. The call site collapses the tiers rather than handing it the object.
    expect(BAL).toMatch(/exposureByUserId: Map<string, number> \| Record<string, number>/)
    expect(GEN).toMatch(/\.map\(\(\[id, counts\]\) => \[id, counts\.visible \+ counts\.reserved\] as const\)/)
    expect(BAL).not.toMatch(/CardCounts|introductions\/capacity/)   // it never imports the new contract
  })

  it('handing the balancer a CardCounts map is a TYPE ERROR, which is what keeps it correct', () => {
    const asObject: Map<string, CardCounts> = new Map([['x', counts(3, 1)]])
    // @ts-expect-error — Map<string, CardCounts> is not assignable to Map<string, number>.
    // If this directive ever becomes "unused", the balancer has started accepting the object and
    // this guarantee is gone: typecheck fails, loudly, rather than the penalty going quietly wrong.
    applyExposureBalancing([{ id: 'x', finalScore: 50 }], asObject)

    // And the reason it must not: the object arithmetic degrades to NaN, so a pass-through would not
    // even fail safely as "no penalty" — it would produce an incomparable ranking key.
    expect(Number.isNaN(balancerPenalty(counts(3, 1) as unknown as number))).toBe(true)
    expect(balancerPenalty(3)).toBe(1.5)                              // the numeric path is intact
    expect(balancerPenalty(2)).toBe(0)                                // softFloor 2, unchanged
  })

  it('the two penalty functions are genuinely different and neither was retuned', () => {
    expect(exposurePenalty(counts(3, 0))).toBe(6)     // new contract: 2/card capped 6
    expect(balancerPenalty(3)).toBe(1.5)              // old balancer: 1.5 above a floor of 2
    expect(DEFAULT_EXPOSURE_BALANCING).toEqual({ softFloor: 2, penaltyPerUnit: 1.5, maxPenalty: 6 })
  })
})

describe('J. capacity is a SEPARATE contract from this ranking input', () => {
  const SRC = readFileSync('lib/generate-recommendations.ts', 'utf8')
  const RPC = readFileSync('supabase/migrations/050_member_pairs.sql', 'utf8')
  const LIMITS = readFileSync('lib/introductions/limits.ts', 'utf8')

  it('the release size is derived from the VISIBLE cap, never written as a bare 2', () => {
    expect(LIMITS).toMatch(/RECOMMENDATIONS_PER_BATCH = MAX_VISIBLE_INTRO_CARDS/)
    expect(LIMITS).toMatch(/getActiveIntroCap\(_tier\?: string\): number \{\s*return RECOMMENDATIONS_PER_BATCH/)
    expect(MAX_VISIBLE_INTRO_CARDS).toBe(2)
    expect(MAX_RESERVED_INTRO_CARDS).toBe(2)
  })

  it('application-side capacity counts the REQUESTER side, VISIBLE tier only', () => {
    // The old read was .in('status', ['suggested','queued']) — one combined cap of 2, which both
    // starved members holding reservations and failed to bound visible cards.
    expect(SRC).toMatch(/\.eq\('requester_id', userId\)\.eq\('status', VISIBLE_STATUS\)/)
    expect(SRC).not.toMatch(/\.eq\('requester_id', userId\)\.in\('status', \['suggested', 'queued'\]\)/)
    expect(SRC).toMatch(/visibleSlotsFree\(\{ visible: aVisible \?\? 0, reserved: 0 \}\)/)
  })

  it('the app-side read is advisory — the RPC under the lock remains authoritative', () => {
    expect(SRC).toMatch(/ADVISORY only/)
    expect(RPC).toMatch(/pg_advisory_xact_lock/)
    expect(RPC).toMatch(/IF a_cards >= p_max_cards OR b_cards >= p_max_cards THEN/)
  })

  it('KNOWN GAP pinned: migration 050 still counts both tiers inside the RPC', () => {
    // Deliberately asserted rather than silently tolerated. Enforcement is the RPC's job, and until
    // the capacity migration replaces this function the DB still uses the combined count. This test
    // must be updated in the same change that replaces create_reciprocal_suggestion.
    expect(RPC).toMatch(/ir\.requester_id = a_id AND ir\.status IN \('suggested','queued'\)/)
    expect(RPC).toMatch(/ir\.requester_id = b_id AND ir\.status IN \('suggested','queued'\)/)
  })

  it('the candidate walk still continues past a capacity result', () => {
    const walk = SRC.slice(SRC.indexOf('export async function walkCandidates'), SRC.indexOf('export async function walkCandidates') + 1600)
    // the walk now also records WHICH counterparts were created, so the new-introduction outbox can
    // announce both sides; the control flow it pins here is unchanged
    expect(walk).toMatch(/if \(o === 'created'\) \{ created\+\+; createdIds\.add\(id\) \}/)
    expect(walk).toMatch(/else if \(o === 'error'\) transientIds\.push\(id\)/)
    // 'capacity' is recorded and the loop proceeds — it is never a break condition
    expect(walk).not.toMatch(/o === 'capacity'/)
  })
})

describe('query safety', () => {
  it('is a single bounded query — no batch lookup, no N+1', async () => {
    const c = client([row('B')])
    await getActiveInboundExposure(c, ['B', 'C'])
    expect(c.calls.tables).toEqual(['intro_requests'])          // recommendation_batches no longer read
    expect(c.calls.targets).toEqual(['B', 'C'])                  // bounded to the candidates ranked
  })

  it('skips the round trip entirely for an empty candidate set', async () => {
    const c = client([row('B')])
    const e = await getActiveInboundExposure(c, [])
    expect(e.size).toBe(0)
    expect(c.calls.tables).toEqual([])
  })

  it('fails open to neutral ordering and logs only an error class', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const e = await getActiveInboundExposure(client(null, { code: '57014', message: 'timeout on intro_requests for user abc' }))
    expect(e.size).toBe(0)                                       // never blocks generation
    const logged = JSON.stringify(spy.mock.calls)
    expect(logged).toContain('57014')
    expect(logged).not.toContain('timeout on intro_requests')    // no raw error text
    expect(logged).not.toContain('abc')                          // no identifiers
    spy.mockRestore()
  })
})
