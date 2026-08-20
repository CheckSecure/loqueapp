import { describe, it, expect, beforeEach, vi } from 'vitest'

let weeklyAdmin: any
const evalMock = vi.fn()
const genMock = vi.fn()
const notifyMock = vi.fn()
const expireMock = vi.fn()

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => weeklyAdmin }))
vi.mock('@/lib/matching/createReciprocalSuggestion', () => ({ expireStaleReciprocalPairs: (...a: any[]) => expireMock(...a) }))
vi.mock('@/lib/introductions/queue', () => ({ evaluateWeeklyEligibility: (...a: any[]) => evalMock(...a) }))
vi.mock('@/lib/notifications/engagement', () => ({
  notifyPendingIntrosActionNeeded: (...a: any[]) => notifyMock(...a),
  isoWeekKey: () => '2026-W33',
}))
vi.mock('@/lib/generate-recommendations', () => ({ generateReciprocalBatchForMember: (...a: any[]) => genMock(...a) }))

import { GET } from '@/app/api/cron/weekly-refresh/route'
import { COVERAGE_MEMBER_LIMIT } from '@/lib/introductions/coverageGeneration'

// users = eligible profiles; activeCards = requester_ids holding a suggested/queued card.
function makeAdmin(users: any[], activeCards: string[]) {
  const b = (table: string) => {
    const self: any = {
      select: () => self, eq: () => self, not: () => self, in: () => self,
      then: (res: any, rej: any) => Promise.resolve({
        data: table === 'profiles' ? users : activeCards.map((id) => ({ requester_id: id })),
        error: null,
      }).then(res, rej),
    }
    return self
  }
  return { from: (t: string) => b(t) }
}
const cronReq = () => ({ headers: new Headers({ authorization: `Bearer ${process.env.CRON_SECRET ?? ''}` }) }) as any

beforeEach(() => {
  evalMock.mockReset(); genMock.mockReset(); notifyMock.mockReset(); expireMock.mockReset()
  process.env.CRON_SECRET = 'test-secret'
  delete process.env.WEEKLY_COVERAGE_GENERATION
  expireMock.mockResolvedValue({ expired: 0 })
  evalMock.mockResolvedValue({ eligible: true, unresolvedCount: 0, activeBatchId: null }) // zero-card ⇒ eligible
  genMock.mockResolvedValue({ count: 1, outcome: 'created', retryable: false })
})

const u = (id: string) => ({ id, email: `${id}@x.com` })

describe('weekly-refresh coverage generation', () => {
  it('rejects without the CRON secret', async () => {
    weeklyAdmin = makeAdmin([], [])
    expect((await GET({ headers: new Headers({}) } as any)).status).toBe(401)
  })

  it('covers zero-card eligible members and SKIPS members who already hold a card', async () => {
    weeklyAdmin = makeAdmin([u('a'), u('b'), u('carded')], ['carded'])
    const body = await (await GET(cronReq())).json()
    // generated only for the two zero-card members, via the reciprocal path, source 'weekly'
    expect(genMock).toHaveBeenCalledTimes(2)
    expect(genMock.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b'])
    expect(genMock.mock.calls.every((c) => c[1] === 'weekly')).toBe(true)
    expect(genMock).not.toHaveBeenCalledWith('carded', 'weekly')
    expect(body.coverageEnabled).toBe(true)
    expect(body.coverage).toMatchObject({ covered: 2 })
    expect(notifyMock).not.toHaveBeenCalled() // no notification when creating cards
  })

  it('a member with ONLY legacy approved rows (not suggested/queued) is treated as zero-card → covered', async () => {
    // approved rows never appear in the suggested/queued active-card set, so the member is covered.
    weeklyAdmin = makeAdmin([u('legacyApproved')], [])
    await GET(cronReq())
    expect(genMock).toHaveBeenCalledWith('legacyApproved', 'weekly')
  })

  it('is DISABLED by the kill-switch (WEEKLY_COVERAGE_GENERATION=off) — no coverage generation', async () => {
    process.env.WEEKLY_COVERAGE_GENERATION = 'off'
    weeklyAdmin = makeAdmin([u('a'), u('b')], [])
    const body = await (await GET(cronReq())).json()
    expect(body.coverageEnabled).toBe(false)
    expect(genMock).not.toHaveBeenCalled()          // broad generation is off by default too
    expect(body.generationDisabledSkipped).toBe(2)  // falls through to the admin-canonical gate
  })

  it('is BOUNDED by the member limit; excess members are deferred (no partial work)', async () => {
    const many = Array.from({ length: COVERAGE_MEMBER_LIMIT + 5 }, (_, i) => u(`m${i}`))
    weeklyAdmin = makeAdmin(many, [])
    const body = await (await GET(cronReq())).json()
    expect(genMock).toHaveBeenCalledTimes(COVERAGE_MEMBER_LIMIT)
    expect(body.coverageStarted).toBe(COVERAGE_MEMBER_LIMIT)
    expect(body.coverage.deferred).toBe(5)
  })

  it('reports an HONEST classified outcome for no candidate — never a one-sided fallback', async () => {
    genMock.mockResolvedValue({ count: 0, outcome: 'no_compatible_candidate', retryable: true })
    weeklyAdmin = makeAdmin([u('a')], [])
    const body = await (await GET(cronReq())).json()
    expect(body.coverage).toMatchObject({ covered: 0, no_candidate: 1 })
  })

  it('idempotent rerun: once members hold a card they are not covered again', async () => {
    weeklyAdmin = makeAdmin([u('a'), u('b')], ['a', 'b']) // both now carded (e.g. from the prior run)
    await GET(cronReq())
    expect(genMock).not.toHaveBeenCalled()
  })

  it('response + logs carry only aggregate counts — no member identifiers', async () => {
    weeklyAdmin = makeAdmin([u('d11d1c98-e016-497f-9308-e5a4f3caa146')], [])
    const body = await (await GET(cronReq())).json()
    expect(JSON.stringify(body)).not.toContain('d11d1c98-e016-497f-9308-e5a4f3caa146')
    expect(JSON.stringify(body)).not.toContain('@x.com')
  })
})

describe('route source guarantees', () => {
  const src = require('node:fs').readFileSync('app/api/cron/weekly-refresh/route.ts', 'utf8')
  it('uses the atomic reciprocal generator (never a one-sided path) and does not log identities', () => {
    expect(src).toContain("generateReciprocalBatchForMember(user.id, 'weekly')")
    // No legacy one-sided generation call path (createIntroRequest / onboarding enqueue).
    expect(src).not.toMatch(/\bcreateIntroRequest\b|enqueueOnboardingRetry/)
    expect(src).not.toMatch(/Error for \$\{user\.email\}/)     // old identity-logging removed
    expect(src).toContain('withActiveCard')
    // A coverage gap is an EMPTY SCREEN: only 'suggested' rows count. A member holding two 'queued'
    // reservations and nothing visible sees the same blank page as a member holding nothing, so they
    // are covered. The old read (suggested+queued) treated a reservation nobody has seen as if it
    // were already on screen and skipped them.
    expect(src).toContain(".eq('status', VISIBLE_STATUS)")
    expect(src).not.toContain("in('status', ['suggested', 'queued'])")
  })
})
