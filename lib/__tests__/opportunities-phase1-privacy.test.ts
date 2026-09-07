import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * PHASE 1 — OPPORTUNITIES.
 *
 * Two jobs, and the first one matters more than the second.
 *
 * 1. A GUARD, NOT A CHANGE. Opportunities deliberately reaches members the creator is NOT matched
 *    with — excludedUserIdsFor() actively removes anyone already matched, because the whole point of
 *    the feature is to create new relationships. A future segmentation phase that "tightens" this
 *    into a matched-members-only rule would silently empty the hiring and business pools and delete
 *    the feature. These tests fail loudly if that ever happens.
 *
 * 2. LEAST PRIVILEGE ON THE ICEBREAKER READ. connectOpportunityResponder loaded both profiles with
 *    `select('*')` — email, stripe_customer_id, subscription_tier, internal scores, moderation flags
 *    — to generate two strings. It now asks for only the columns icebreakers.ts consumes, and falls
 *    back to the previous query verbatim if any of those columns turn out not to exist, so the
 *    generated output can never regress.
 *
 * NOTE ON SCOPE: community scoping (student vs professional) is NOT tested here and NOT implemented.
 * It depends on profiles.member_type, which does not exist yet. See the Phase 1 report.
 */

const cfg = vi.hoisted(() => ({
  pool: [] as any[],              // profiles returned for the candidate pool query
  blocks: [] as any[],
  activeMatches: [] as any[],     // matches used by excludedUserIdsFor
  removedMatches: [] as any[],
  openIntros: [] as any[],
  delivered: [] as any[],         // opportunity_candidates rows
  narrowReadFails: false,         // simulate a column in the narrow list not existing
  profilesInResult: null as any,  // overrides the profiles list read (account_status lookup)
}))

const profileSelects = vi.hoisted(() => [] as string[])
/** Rows inserted into `messages` — the generated system intro line. */
const systemMessages = vi.hoisted(() => [] as any[])

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const state: any = { table, statuses: null as string[] | null }
      const b: any = {
        select: (cols: string) => {
          if (table === 'profiles') profileSelects.push(cols)
          return b
        },
        eq: () => b, or: () => b, is: () => b, gte: () => b, limit: () => b,
        not: () => b, neq: () => b, order: () => b,
        insert: (p: any) => { if (table === 'messages') systemMessages.push(p); return b },
        update: () => b,
        single: async () => {
          if (table === 'profiles') {
            // Simulate a column named in the narrow list not existing in the live schema: PostgREST
            // fails the whole SELECT. The '*' retry must then succeed.
            const last = profileSelects[profileSelects.length - 1]
            if (cfg.narrowReadFails && last !== '*') {
              return { data: null, error: { message: 'column profiles.practice_areas does not exist' } }
            }
            return { data: { id: 'p', title: 'GC', company: 'Acme', bio: 'A bio.' }, error: null }
          }
          return { data: { id: `${table}-1` }, error: null }
        },
        maybeSingle: async () => {
          if (table === 'opportunities') return { data: { id: 'opp1', creator_id: 'creator', status: 'active' }, error: null }
          if (table === 'opportunity_responses') return { data: { id: 'resp1', status: 'interested' }, error: null }
          return { data: null, error: null }
        },
        then: (res: any, rej: any) => {
          let out: any = { data: [], error: null }
          if (table === 'profiles') out = { data: cfg.profilesInResult ?? cfg.pool, error: null }
          else if (table === 'blocked_users') out = { data: cfg.blocks, error: null }
          else if (table === 'matches') out = { data: state.statuses ? cfg.activeMatches : cfg.removedMatches, error: null }
          else if (table === 'intro_requests') out = { data: cfg.openIntros, error: null }
          else if (table === 'opportunity_candidates') out = { data: cfg.delivered, error: null }
          return Promise.resolve(out).then(res, rej)
        },
      }
      // `.in('status', [...])` distinguishes the active-match query from the removed-match one.
      b.in = (col: string, vals: any[]) => { if (col === 'status') state.statuses = vals; return b }
      return b
    },
  }),
}))

vi.mock('@/lib/opportunities/rateLimits', () => ({ rateLimitedUserIds: async () => new Set<string>() }))
vi.mock('@/lib/referrals/exclusions', () => ({ getReferralExclusionsForUser: async () => new Set<string>() }))

import { selectCandidates } from '@/lib/opportunities/matching'

/** A candidate that clears the hiring threshold of 40 comfortably. */
const strongCandidate = (id: string) => ({
  id,
  seniority: 'Senior',
  role_type: 'In-house Counsel',
  expertise: '{Privacy,"Data Protection",Regulatory}',
  trust_score: 50,
  company: 'Different Co',
  networkValueScore: 50,
  responsivenessScore: 50,
  opp_delivered_count: 0,
  opp_response_rate: null,
  opp_conversation_continuation_rate: null,
  subscription_tier: 'professional',
  account_status: 'active',
  profile_complete: true,
})

const opportunity: any = {
  id: 'opp1',
  creator_id: 'creator',
  type: 'hiring',
  include_recruiters: false,
  criteria: { seniority: 'Senior', expertise: ['Privacy', 'Data Protection', 'Regulatory'], role_types: ['In-house Counsel'] },
}

beforeEach(() => {
  cfg.pool = []
  cfg.blocks = []
  cfg.activeMatches = []
  cfg.removedMatches = []
  cfg.openIntros = []
  cfg.delivered = []
  cfg.narrowReadFails = false
  cfg.profilesInResult = null
  profileSelects.length = 0
  systemMessages.length = 0
})

describe('Opportunities reach beyond the creator’s matched network — this is the feature', () => {
  it('an UNMATCHED member is delivered an opportunity', async () => {
    cfg.pool = [strongCandidate('stranger')]
    cfg.activeMatches = []           // no relationship whatsoever with the creator

    const res = await selectCandidates(opportunity, 'Creator Co')
    expect(res.delivered.map((d) => d.userId)).toContain('stranger')
  })

  it('an ALREADY-MATCHED member is excluded (they need no introduction)', async () => {
    cfg.pool = [strongCandidate('already-connected')]
    cfg.activeMatches = [{ user_a_id: 'creator', user_b_id: 'already-connected', status: 'active', removed_at: null }]

    const res = await selectCandidates(opportunity, 'Creator Co')
    expect(res.delivered.map((d) => d.userId)).not.toContain('already-connected')
  })

  it('REGRESSION GUARD: the pool is not filtered down to matched members', async () => {
    // If a future change makes Opportunities matched-only, the unmatched candidate disappears and
    // this fails. That is the entire point of the test.
    cfg.pool = [strongCandidate('stranger-a'), strongCandidate('stranger-b')]
    cfg.activeMatches = []

    const res = await selectCandidates(opportunity, 'Creator Co')
    expect(res.delivered.length).toBeGreaterThan(0)
    expect(res.mode).not.toBe('no_qualified_pool')
  })

  it('a blocked member is still excluded (existing protection intact)', async () => {
    cfg.pool = [strongCandidate('blocked-person')]
    cfg.blocks = [{ user_id: 'creator', blocked_user_id: 'blocked-person' }]

    const res = await selectCandidates(opportunity, 'Creator Co')
    expect(res.delivered.map((d) => d.userId)).not.toContain('blocked-person')
  })

  it('a same-company member is still excluded (existing protection intact)', async () => {
    cfg.pool = [{ ...strongCandidate('colleague'), company: 'Creator Co' }]

    const res = await selectCandidates(opportunity, 'Creator Co')
    expect(res.delivered.map((d) => d.userId)).not.toContain('colleague')
  })
})

describe('connectOpportunityResponder — icebreaker profile read is least-privilege', () => {
  /**
   * Imported lazily inside each test: connect.ts pulls in the notifications module at call time and
   * the module graph is cheaper to establish per-test than to mock wholesale. Only the profile
   * SELECT shape is under test here — the surrounding match/conversation writes are covered by the
   * existing opportunities suite.
   */
  const FORBIDDEN = ['email', 'stripe_customer_id', 'subscription_tier', 'trust_score', 'is_admin', 'account_status']

  it('asks only for the columns icebreakers.ts actually consumes', async () => {
    const { generateIcebreakers } = await import('@/lib/messaging/icebreakers')
    // Sanity-check the premise: the generator reads title/company/bio and nothing sensitive.
    const prompts = generateIcebreakers({ userA: {} as any, userB: { title: 'GC', company: 'Acme', bio: 'A bio.' } as any })
    expect(prompts.join(' ')).toContain('Acme')

    const { ICEBREAKER_PROFILE_COLUMNS } = await import('@/lib/opportunities/connect')
    for (const forbidden of FORBIDDEN) {
      expect(ICEBREAKER_PROFILE_COLUMNS.split(',').map((s) => s.trim())).not.toContain(forbidden)
    }
    expect(ICEBREAKER_PROFILE_COLUMNS).toContain('title')
    expect(ICEBREAKER_PROFILE_COLUMNS).toContain('company')
    expect(ICEBREAKER_PROFILE_COLUMNS).toContain('bio')
  })
})


describe('connectOpportunityResponder — the narrow read falls back rather than degrading output', () => {
  const setUpConnectablePair = () => {
    cfg.profilesInResult = [
      { id: 'creator', account_status: 'active' },
      { id: 'responder', account_status: 'active' },
    ]
  }

  it('normal case: asks for the narrow list and never falls back to select(*)', async () => {
    setUpConnectablePair()
    const { connectOpportunityResponder } = await import('@/lib/opportunities/connect')
    const res = await connectOpportunityResponder({ opportunityId: 'opp1', creatorId: 'creator', responderId: 'responder' })

    expect(res.ok).toBe(true)
    const icebreakerReads = profileSelects.filter((c) => c !== 'id, account_status')
    expect(icebreakerReads.length).toBeGreaterThan(0)
    expect(icebreakerReads).not.toContain('*')
    // The system intro message was still generated from a real profile, not the empty fallback.
    expect(systemMessages.filter((m) => m.is_system)).toHaveLength(1)
  })

  it('missing column: falls back to select(*) so the generated message is unchanged', async () => {
    setUpConnectablePair()
    cfg.narrowReadFails = true
    const { connectOpportunityResponder } = await import('@/lib/opportunities/connect')
    const res = await connectOpportunityResponder({ opportunityId: 'opp1', creatorId: 'creator', responderId: 'responder' })

    expect(res.ok).toBe(true)
    expect(profileSelects).toContain('*')            // the retry happened
    const inserted = systemMessages.filter((m) => m.is_system)
    expect(inserted).toHaveLength(1)
    // The real generated intro, not the catch-block's 'You were introduced based on a shared
    // opportunity.' degradation line.
    expect(inserted[0].content).toContain('introduced')
    expect(inserted[0].content).toContain('Shared opportunity')
  })
})
