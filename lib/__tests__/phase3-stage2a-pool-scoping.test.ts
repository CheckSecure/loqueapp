import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Placement assertions compare offsets in EXECUTABLE code, with comment lines stripped.
 * Learned the hard way: the comments that explain "this filter must precede the exhaustion valve"
 * necessarily name `afterSoft` and `MIN_RELEVANCE_SCORE`, so a raw source scan finds the
 * explanation before the code and reports a failure against documentation rather than behaviour.
 */
const codeOnly = (src: string) =>
  src.split('\n').filter((l) => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')

/**
 * PHASE 3 STAGE 2A — CANDIDATE-POOL ISOLATION.
 *
 * Stage 1 made the DATABASE refuse to write a cross-community relationship, and that remains the
 * authority. This stage answers a different question: what happens to a cross-community profile
 * BEFORE the write is attempted?
 *
 * The audit found four concrete harms that Stage 1 does not address, and these tests exist for
 * them specifically rather than for "the pair is rejected":
 *
 *   1. CAPACITY — the reciprocal ranker slices to maxCount and then spends a budget of only
 *      WALK_LIMITS.maxRpcCalls = 8 RPC calls. A cross-community candidate ranked highly consumes
 *      one, returns 'ineligible', and a member can end a cycle with fewer introductions than the
 *      network could have given them.
 *   2. RANKING — an opportunity's near-threshold fallback delivers `[scored[0]]` unconditionally.
 *   3. DISCLOSURE — the Concierge admin surface returns a candidate's NAME and COMPANY before any
 *      write is attempted at all.
 *   4. ORDER — a filter that reordered would change Professional↔Professional results even when it
 *      removed nothing.
 *
 * So the tests below assert what the pools CONTAIN and in WHAT ORDER, not merely that a bad pair
 * eventually fails.
 */

// ── programmable fake ──────────────────────────────────────────────────────────────────────────
const h = vi.hoisted(() => {
  const state = {
    profiles: [] as any[],
    self: null as any,
    tableReplies: new Map<string, any>(),
    rpc: [] as { name: string; args: any }[],
    rpcOutcome: 'created' as string,
  }
  const reset = () => {
    state.profiles = []; state.self = null; state.rpc.length = 0
    state.rpcOutcome = 'created'; state.tableReplies.clear()
  }
  const makeClient = () => ({
    rpc: async (name: string, args: any) => {
      state.rpc.push({ name, args })
      return { data: state.rpcOutcome, error: null }
    },
    from(table: string) {
      const q: any = {
        _single: false,
        select: () => q, eq: () => q, neq: () => q, in: () => q, or: () => q, is: () => q,
        not: () => q, gt: () => q, gte: () => q, lt: () => q, order: () => q, limit: () => q,
        range: () => q, ilike: () => q, contains: () => q, filter: () => q,
        insert: () => q, update: () => q, delete: () => q,
        single: async () => ({ data: table === 'profiles' ? state.self : null, error: null }),
        maybeSingle: async () => ({ data: table === 'profiles' ? state.self : null, error: null }),
        then: (res: any, rej: any) => q._resolve().then(res, rej),
        _resolve: async () =>
          table === 'profiles'
            ? { data: state.profiles, error: null }
            : { data: state.tableReplies.get(table) ?? [], error: null },
      }
      return q
    },
  })
  return { state, reset, makeClient }
})

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.makeClient() }))
vi.mock('@/lib/referrals/exclusions', () => ({ getReferralExclusionsForUser: async () => new Set() }))

beforeEach(() => { h.reset(); vi.resetModules() })

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────
const member = (id: string, member_type: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  member_type,
  full_name: `Member ${id}`,
  company: `Co ${id}`,
  account_status: 'active',
  profile_complete: true,
  is_test_account: false,
  is_admin: false,
  matching_paused: false,
  email: `${id}@x.com`,
  role_type: 'In-house Counsel',
  seniority: 'Senior',
  expertise: '{Privacy,"Data Protection",Regulatory}',
  ...extra,
})

const PRO = (id: string, extra = {}) => member(id, 'professional', extra)
const NEXT = (id: string, extra = {}) => member(id, 'next', extra)

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('filterSameCommunity — the one rule, and it fails closed', () => {
  const load = () => import('@/lib/community/memberType')

  it('professional viewer + professional candidate => included', async () => {
    const { filterSameCommunity } = await load()
    expect(filterSameCommunity(PRO('v'), [PRO('a')]).map((c: any) => c.id)).toEqual(['a'])
  })

  it('professional viewer + next candidate => excluded', async () => {
    const { filterSameCommunity } = await load()
    expect(filterSameCommunity(PRO('v'), [NEXT('a')])).toEqual([])
  })

  it('next viewer + next candidate => included', async () => {
    const { filterSameCommunity } = await load()
    expect(filterSameCommunity(NEXT('v'), [NEXT('a')]).map((c: any) => c.id)).toEqual(['a'])
  })

  it('next viewer + professional candidate => excluded', async () => {
    const { filterSameCommunity } = await load()
    expect(filterSameCommunity(NEXT('v'), [PRO('a')])).toEqual([])
  })

  it('an unknown VIEWER community yields an EMPTY pool, never an unscoped one', async () => {
    const { filterSameCommunity } = await load()
    const pool = [PRO('a'), PRO('b'), NEXT('c')]
    for (const bad of [null, undefined, member('v', null), member('v', ''),
                       member('v', 'professsional'), member('v', 'NEXT'), {} as any]) {
      expect(filterSameCommunity(bad as any, pool), JSON.stringify(bad)).toEqual([])
    }
  })

  it('an unknown CANDIDATE member_type is dropped, never defaulted to professional', async () => {
    const { filterSameCommunity } = await load()
    const pool = [PRO('good'), member('x', null), member('y', ''), member('z', 'Professional'),
                  member('w', 'professsional'), { id: 'novalue' } as any]
    expect(filterSameCommunity(PRO('v'), pool).map((c: any) => c.id)).toEqual(['good'])
  })

  it('a mixed pool keeps only the same community — and IN ORDER', async () => {
    const { filterSameCommunity } = await load()
    const pool = [NEXT('n1'), PRO('p1'), NEXT('n2'), PRO('p2'), PRO('p3'), NEXT('n3')]
    expect(filterSameCommunity(PRO('v'), pool).map((c: any) => c.id)).toEqual(['p1', 'p2', 'p3'])
    expect(filterSameCommunity(NEXT('v'), pool).map((c: any) => c.id)).toEqual(['n1', 'n2', 'n3'])
  })

  it('on an all-Professional pool it is a NO-OP: same members, same order, same objects', async () => {
    const { filterSameCommunity } = await load()
    const pool = [PRO('a'), PRO('b'), PRO('c'), PRO('d'), PRO('e')]
    const out = filterSameCommunity(PRO('v'), pool)
    expect(out).toEqual(pool)
    // Identity, not just equality: nothing was copied, rewrapped or re-sorted.
    out.forEach((c: any, i: number) => expect(c).toBe(pool[i]))
  })

  it('has NO mentorship exception — the bridge must never live in the ordinary rule', async () => {
    const src = readFileSync('lib/community/memberType.ts', 'utf8')
    const code = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/mentor|open_to_next_mentorship|seeking_next_mentorship|bridge/i)
    const { filterSameCommunity } = await load()
    expect(filterSameCommunity(PRO('v', { open_to_next_mentorship: true }),
                               [NEXT('a', { seeking_next_mentorship: true })])).toEqual([])
  })

  it('partitionByCommunity now exists AND has a caller — it did not ship unused', async () => {
    // UPDATED IN STAGE 2B. This assertion originally required partitionByCommunity to be ABSENT,
    // because Stage 2A had no caller for it and an unused export is where drift starts. Stage 2B is
    // the approved caller, so the protection is inverted rather than deleted: the export must now
    // exist, and it must be USED by the admin batch generator. Simply removing the check would drop
    // the guarantee it encoded — that partition logic never sits in the tree without a consumer.
    // The "has a caller" half of this guarantee is asserted in
    // lib/__tests__/phase3-stage2b-batch-partition.test.ts, which is where the caller lands.
    expect(Object.keys(await load())).toContain('partitionByCommunity')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('Pool 1 — the reciprocal ranker scopes the candidate UNIVERSE', () => {
  const rank = async (self: any, pool: any[], maxCount?: number) => {
    h.state.self = self
    h.state.profiles = pool
    const { rankCandidatesForUser } = await import('@/lib/generate-recommendations')
    return rankCandidatesForUser(self.id, maxCount)
  }

  it('a Professional member never sees a Next candidate', async () => {
    const r = await rank(PRO('me'), [PRO('p1'), NEXT('n1'), PRO('p2'), NEXT('n2')], 50)
    const ids = r.candidates.map((c: any) => c.id)
    expect(ids).not.toContain('n1')
    expect(ids).not.toContain('n2')
  })

  it('a Next member never sees a Professional candidate', async () => {
    const r = await rank(NEXT('me'), [PRO('p1'), NEXT('n1'), PRO('p2')], 50)
    expect(r.candidates.map((c: any) => c.id)).not.toContain('p1')
    expect(r.candidates.map((c: any) => c.id)).not.toContain('p2')
  })

  it('the filter is ABOVE the exhaustion valve, which draws from the same array', async () => {
    // The audit's specific finding: the valve re-admits soft-excluded members from allUsers when
    // the fresh pool is thin. Scoping only the fresh set would let it hand back Next candidates.
    const src = codeOnly(readFileSync('lib/generate-recommendations.ts', 'utf8'))
    const body = src.slice(src.indexOf('export async function rankCandidatesForUser'))
    const filterAt = body.indexOf('filterSameCommunity(')
    expect(filterAt).toBeGreaterThan(-1)
    for (const later of [
      'classifyIntroHistory(',      // exclusion sets
      'exhaustionThreshold()',      // the valve
      'afterSoft',                  // valve output
      'calculateFinalScore(',       // scoring
      'applyThrottling(',
      'applyJuniorDistributionControl(',
      '.slice(0, maxCount',         // truncation
    ]) {
      expect(filterAt, `community filter must precede ${later}`).toBeLessThan(body.indexOf(later))
    }
  })

  it('the scoped array IS the array every downstream stage reads', async () => {
    // Structural, because the alternative — a second unscoped variable surviving alongside it — is
    // exactly the bug this placement prevents and is invisible to a behavioural test.
    const src = readFileSync('lib/generate-recommendations.ts', 'utf8')
    const body = src.slice(src.indexOf('export async function rankCandidatesForUser'))
    expect(body).toMatch(/const allUsers = filterSameCommunity\(newUserProfile, eligibleUsers\)/)
    // eligibleUsers (the unscoped result) must be referenced ONCE only — to build allUsers.
    expect(body.match(/eligibleUsers/g)).toHaveLength(2) // its declaration + that one use
  })

  it('a cross-community candidate cannot consume one of the 8 RPC calls', async () => {
    // WALK_LIMITS.maxRpcCalls = 8 per generation run. This is objective #2 in its concrete form:
    // Stage 1 would answer 'ineligible', but only after the budget was already spent.
    const { WALK_LIMITS } = await import('@/lib/generate-recommendations')
    expect(WALK_LIMITS.maxRpcCalls).toBe(8)

    h.state.self = PRO('me')
    h.state.profiles = [NEXT('n1'), NEXT('n2'), NEXT('n3'), PRO('p1')]
    const { rankCandidatesForUser } = await import('@/lib/generate-recommendations')
    const r = await rankCandidatesForUser('me', 50)
    // Whatever survives ranking, no Next member is in it — so walkCandidates cannot spend a call
    // on one.
    expect(r.candidates.every((c: any) => c.id.startsWith('p'))).toBe(true)
  })

  it('an all-Professional network keeps its ENTIRE pool — the filter removes nothing', async () => {
    // NOT an order comparison across runs: this ranker deliberately contains randomness (exposure
    // balancing / throttling), so two runs legitimately differ in order and comparing them would
    // test the wrong thing. Order preservation is a property of the FILTER, and it is proven
    // exactly, on identity, in the helper block above. What matters here is membership: on an
    // all-Professional network nothing is dropped.
    const pool = [PRO('p1'), PRO('p2'), PRO('p3')]
    const r = await rank(PRO('me'), pool, 50)
    expect(r.candidates.map((c: any) => c.id).sort()).toEqual(['p1', 'p2', 'p3'])
    expect(r.rankerStages.eligible).toBe(3) // the scoped universe is the whole eligible network
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('Pool 2 — Concierge cannot disclose a cross-community candidate', () => {
  it('the route returns only same-community candidates', async () => {
    h.state.self = PRO('requester')
    h.state.profiles = [NEXT('n1'), PRO('p1'), NEXT('n2')]
    h.state.tableReplies.set('concierge_requests', { id: 'c1', requester_id: 'requester' })

    // The route reads the concierge row with .maybeSingle() on a non-profiles table.
    const { rankCandidatesForUser } = await import('@/lib/generate-recommendations')
    const ranked = await rankCandidatesForUser('requester', 5)
    const shown = ranked.candidates.slice(0, 5)

    expect(shown.map((c: any) => c.id)).not.toContain('n1')
    expect(shown.map((c: any) => c.id)).not.toContain('n2')
    // The disclosure this prevents: name and company reaching an admin screen.
    for (const c of shown) expect(c.member_type).toBe('professional')
  })

  it('the route adds NO second community filter of its own — one rule, in the ranker', () => {
    // A duplicate filter here would be a second definition that can drift from the ranker's.
    const src = readFileSync('app/api/admin/concierge/[id]/candidates/route.ts', 'utf8')
    expect(src).not.toMatch(/filterSameCommunity|member_type|community_pair_allowed|sameCommunity/)
    expect(src).toContain('rankCandidatesForUser(')
  })

  it('and it is not an admin bypass — the route creates no exemption', () => {
    const src = readFileSync('app/api/admin/concierge/[id]/candidates/route.ts', 'utf8')
    expect(src).not.toMatch(/is_admin|bypass|skipCommunity|allowCross/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('Pool 4 — replacements are scoped per RECIPIENT', () => {
  const SRC = readFileSync('app/api/admin/batch/[batchId]/generate-replacements/route.ts', 'utf8')

  it('scoping is per recipient, not on the pool shared across recipients', () => {
    // The shared candidatePool serves every recipient in the run, and two recipients can belong to
    // different communities — so a single filter on the shared pool would be wrong for one of them.
    expect(SRC).toMatch(/const recipientPool = filterSameCommunity\(recipient, candidatePool\)/)
  })

  it('the scoring loop reads the scoped pool, and nothing else does', () => {
    expect(SRC).toMatch(/for \(const candidate of recipientPool\)/)
    expect(SRC).not.toMatch(/for \(const candidate of candidatePool\)/)
  })

  it('scoping precedes scoring, sorting, the relevance cut and the capacity fill', () => {
    // Scoped to the per-recipient loop: MIN_RELEVANCE_SCORE is also a top-level const declared
    // hundreds of lines earlier, so a whole-file scan would compare against the wrong occurrence.
    const code = codeOnly(SRC)
    const loop = code.slice(code.indexOf('for (const r of recipientsNeedingFill) {\n      if (r.needed === 0) continue'))
    const at = loop.indexOf('filterSameCommunity(recipient, candidatePool)')
    expect(at).toBeGreaterThan(-1)
    for (const later of ['const score = scoreMatch(recipient, candidate)', 'scored.sort(',
                         'score < MIN_RELEVANCE_SCORE', 'degreeOf(r.recipientId)']) {
      expect(at, `must precede ${later}`).toBeLessThan(loop.indexOf(later))
    }
  })

  it('no exhausted-pool or fallback branch reads the unscoped pool', () => {
    // Every later reference to the unscoped array must be its own construction, not a read.
    const after = SRC.slice(SRC.indexOf('const recipientPool ='))
    expect(after).not.toMatch(/candidatePool\b(?!\))/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('Pools 5-7 — opportunities scope before scoring, threshold, fallback and ceiling', () => {
  const SRC = readFileSync('lib/opportunities/matching.ts', 'utf8')
  const selector = (name: string) => {
    const from = SRC.indexOf(`export async function ${name}(`)
    return SRC.slice(from, SRC.indexOf('\nexport ', from + 1))
  }

  for (const [name, label] of [['selectCandidates', 'hiring'], ['selectProviders', 'business'],
                               ['selectRecruiters', 'recruiter']] as const) {
    it(`${label}: the community filter is the FIRST link in the chain`, () => {
      const fn = selector(name)
      expect(fn).toMatch(/const filtered = filterSameCommunity\(creator, pool \?\? \[\]\)/)
      const at = fn.indexOf('filterSameCommunity(')
      for (const later of ['const scored', '.sort(', 'applyThresholdAndFallback(']) {
        expect(at, `${name}: must precede ${later}`).toBeLessThan(fn.indexOf(later))
      }
    })

    it(`${label}: the creator argument is REQUIRED, so a caller cannot omit it`, () => {
      // An optional parameter would default to undefined -> empty pool, which fails closed but
      // silently. A required one fails at compile time instead.
      expect(selector(name)).toMatch(/creator: HasMemberType \| null,\n\): Promise<SelectResult>/)
    })
  }

  it('the near-threshold fallback cannot reach a cross-community candidate', () => {
    // applyThresholdAndFallback returns [scored[0]] unconditionally when nothing clears the
    // threshold. It operates on `scored`, which is derived from the already-filtered array.
    const fb = SRC.slice(SRC.indexOf('function applyThresholdAndFallback'))
    expect(fb).toMatch(/delivered: \[scored\[0\]\]/)
    for (const name of ['selectCandidates', 'selectProviders', 'selectRecruiters']) {
      const fn = selector(name)
      expect(fn.indexOf('filterSameCommunity(')).toBeLessThan(fn.indexOf('applyThresholdAndFallback('))
    }
  })

  it('deliveryCeiling capacity cannot be consumed by a cross-community candidate', () => {
    const fb = SRC.slice(SRC.indexOf('function applyThresholdAndFallback'))
    expect(fb).toMatch(/above\.slice\(0, deliveryCeiling\)/)
    // `above` derives from `scored`, which derives from `filtered`, which is the scoped array.
    for (const name of ['selectCandidates', 'selectProviders', 'selectRecruiters']) {
      expect(selector(name)).toMatch(/const scored: ScoredCandidate\[\] = filtered\.map/)
    }
  })

  it('re-delivery (opportunities-maintain tranche 2) stays scoped, because the rule lives in the selector', () => {
    // A filter placed in app/api/opportunities/create would be bypassed entirely by this path.
    const cron = readFileSync('app/api/cron/opportunities-maintain/route.ts', 'utf8')
    expect(cron).toMatch(/deliverOpportunity\(opp as any, \{ tranche: [12] \}\)/)
    expect(cron).not.toMatch(/filterSameCommunity|member_type/)
    expect(SRC).toMatch(/await selectCandidates\(opportunity, creatorCompany, creator\)/)
    expect(SRC).toMatch(/await selectRecruiters\(opportunity, creatorCompany, creator\)/)
  })

  it('an unreadable creator fails closed — deliver to nobody, not to everybody', () => {
    const dl = SRC.slice(SRC.indexOf('export async function deliverOpportunity'))
    expect(dl).toMatch(/const creator = \(creatorProfile \?\? null\) as HasMemberType \| null/)
    // filterSameCommunity(null, ...) === [] is proven in the helper block above.
  })

  it('the recruiter pool’s pre-existing is_admin / matching_paused asymmetry is NOT changed', () => {
    // Explicitly out of scope. Tightening it would change who receives recruiter opportunities.
    const fn = selector('selectRecruiters')
    expect(fn).not.toContain('applyMemberEligibility')
    expect(fn).toMatch(/\.eq\('recruiter', true\)/)
    expect(fn).toMatch(/\.not\('is_test_account', 'is', true\)/)
  })

  it('thresholds, ceilings, windows and scoring constants are untouched', () => {
    expect(SRC).toMatch(/NEAR_THRESHOLD_WINDOW = 5/)
    expect(SRC).toMatch(/BOOTSTRAP_DELIVERED_CUTOFF = 3/)
    expect(SRC).toMatch(/BOOTSTRAP_MEDIAN_RATE = 0\.5/)
    expect(SRC).toMatch(/MIN_TAGS\.hiring/)
    expect(SRC).toMatch(/MIN_TAGS\.business/)
    expect(SRC).toMatch(/MIN_TAGS\.recruiter/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('member_type data flow: available internally, never widened outward', () => {
  it('is named in the internal selects that need it', () => {
    const m = readFileSync('lib/opportunities/matching.ts', 'utf8')
    // Both opportunity select lists interpolate MEMBER_TYPE_COLUMNS.
    expect(m.match(/\$\{MEMBER_TYPE_COLUMNS\}/g)?.length).toBeGreaterThanOrEqual(3)
    // Pools 1, 2 and 4 use select('*'), so the column is already present without a query change.
    expect(readFileSync('lib/generate-recommendations.ts', 'utf8'))
      .toMatch(/\.from\('profiles'\)\s*\n\s*\.select\('\*'\)\s*\n\s*\.neq\('id', userId\)/)
  })

  it('is NOT added to the public profile surface', () => {
    const pub = readFileSync('lib/profiles/publicProfile.ts', 'utf8')
    expect(pub).not.toContain('member_type')
    const sel = pub.slice(pub.indexOf('PUBLIC_PROFILE_SELECT'))
    expect(sel).not.toContain('member_type')
  })

  it('is not written into opportunity_candidates and does not reach a client', () => {
    const m = readFileSync('lib/opportunities/matching.ts', 'utf8')
    const insert = m.slice(m.indexOf('const rows = ['), m.indexOf("from('opportunity_candidates').insert"))
    expect(insert).not.toContain('member_type')
    // The delivered shape is ids/roles/scores only.
    expect(insert).toMatch(/user_id: c\.userId/)
    expect(insert).toMatch(/relevance_score: Math\.round\(c\.score\)/)
  })

  it('the For-you read needs no presentation-layer filter', () => {
    // Scoping candidate CREATION is the fix; a client-side filter would paper over an upstream bug.
    const page = readFileSync('app/dashboard/opportunities/page.tsx', 'utf8')
    expect(page).not.toContain('member_type')
    expect(page).not.toContain('filterSameCommunity')
  })

  it('the stale "member_type does not exist yet" comment is gone', () => {
    expect(readFileSync('lib/opportunities/matching.ts', 'utf8'))
      .not.toMatch(/member_type, which does not exist yet/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('Stage 2B (Pool 3) was NOT implemented', () => {
  it('the admin batch generator uses PARTITIONING, never the viewer-relative filter', () => {
    // UPDATED IN STAGE 2B. This originally required the generator to contain no community code at
    // all, because Stage 2A deliberately excluded Pool 3. Stage 2B is the approved change, so the
    // guard is narrowed rather than deleted: what still must never appear is filterSameCommunity.
    // Pool 3 has no viewer, so a viewer-relative filter there would be the "score everyone, then
    // drop cross edges" shape this whole stage rejects.
    const src = readFileSync('app/api/admin/generate-batch/route.ts', 'utf8')
    expect(src).not.toContain('filterSameCommunity')
    expect(src).toContain('partitionByCommunity')
  })

  it('buildScoringContext still derives its IDF corpus from the whole cohort', () => {
    // Stage 2B must partition BEFORE this, because memberCount is the IDF denominator. Recorded
    // here so the reason survives with the code rather than only in a report.
    const bs = readFileSync('lib/matching/batch-scoring.ts', 'utf8')
    expect(bs).toMatch(/memberCount: profiles\.length/)
    expect(bs).not.toContain('member_type')
  })
})
