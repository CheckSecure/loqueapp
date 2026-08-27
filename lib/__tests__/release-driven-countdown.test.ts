import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * THE COUNTDOWN MUST BE DRIVEN BY A RELEASE, NOT BY THE CALENDAR.
 *
 * resolveThursdayBanner used to compute nextBatch(now) and count down to it unconditionally. It
 * consulted nothing about whether a batch had been approved, so every Thursday the countdown rolled
 * forward on its own — telling members the next batch was coming while this week's had not been
 * prepared. A clock is not evidence that anything shipped.
 *
 * Nor was there anything to consult: introduction_batches has no released_at, and its `status` is
 * flipped to 'active' at approve-batch:66 BEFORE the materialisation loop at :129, so a failed or
 * partial approval leaves a batch 'active' with zero cards. Migration 074 adds the evidence.
 */

const h = vi.hoisted(() => ({
  releaseRow: null as any,
  readError: null as any,
  inserted: [] as any[],
  insertError: null as any,
  /** COMMITTED visible cards the RPC will find. Evidence, not a caller's tally. */
  committedCards: [] as any[],
  cardsReadError: null as any,
  /** Immutable facts, as the RPC would hold them. */
  facts: [] as any[],
  currentKey: 'thu-2026-08-20',
  knownBatches: [] as string[],
  batchMaterializedThisWindow: {} as Record<string, number>,
  batchMaterializedEarlier: {} as Record<string, number>,
  weeklyCardsThisWindow: 0,
  rpcError: null as any,
  rpcCalls: [] as any[],
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    // public.finalize_weekly_release, modelled faithfully: it DERIVES the week, verifies committed
    // cards itself, is idempotent on the key, and RAISES when nothing was released.
    rpc: async (name: string, params: any) => {
      h.rpcCalls.push({ name, params })
      if (name !== 'finalize_weekly_release') return { data: null, error: { code: '42883' } }
      if (h.rpcError) return { data: null, error: h.rpcError }
      const src = params.p_source
      const bid = params.p_batch_id ?? null
      // contract, exactly as the RPC enforces it
      if (!['admin_approval', 'weekly_cron'].includes(src)) return { data: null, error: { message: 'invalid_source' } }
      if (src === 'admin_approval' && !bid) return { data: null, error: { message: 'admin_requires_batch_id' } }
      if (src === 'weekly_cron' && bid) return { data: null, error: { message: 'weekly_forbids_batch_id' } }
      // IDENTITY BEFORE CALENDAR: an already-finalized batch returns its OWN fact
      const byBatch = h.facts.find((f: any) => bid && f.batch_id === bid)
      if (byBatch) return { data: [{ ...byBatch, was_existing: true }], error: null }
      if (bid && !h.knownBatches.includes(bid)) return { data: null, error: { message: 'batch_not_found' } }
      // this week already finalized by anyone
      const byKey = h.facts.find((f: any) => f.release_key === h.currentKey)
      if (byKey) return { data: [{ ...byKey, was_existing: true }], error: null }
      // evidence scoped to the run
      const evidence = src === 'admin_approval' ? (h.batchMaterializedThisWindow[bid!] ?? 0) : h.weeklyCardsThisWindow
      if (evidence <= 0) {
        if (src === 'admin_approval' && (h.batchMaterializedEarlier[bid!] ?? 0) > 0) {
          return { data: null, error: { message: 'batch_belongs_to_earlier_window' } }
        }
        return { data: null, error: { message: 'no_visible_introductions' } }
      }
      const fact = { release_key: h.currentKey, released_at: AFTER_WINDOW.toISOString(), cards_released: evidence, source: src, batch_id: bid }
      h.facts.push(fact)
      return { data: [{ ...fact, was_existing: false }], error: null }
    },
    from: (t: string) => {
      const b: any = { t, filters: {} as Record<string, unknown> }
      b.select = () => b; b.eq = (column: string, value: unknown) => { b.filters[column] = value; return b }; b.gte = () => b; b.limit = () => b; b.order = () => b
      b.maybeSingle = async () => ({
        data: t === 'weekly_batch_releases' ? (h.facts.find((f: any) =>
          f.release_key === b.filters.release_key &&
          (b.filters.source === undefined || f.source === b.filters.source)) ?? null) : null,
        error: t === 'weekly_batch_releases' ? h.readError : null,
      })
      b.then = (res: any) => Promise.resolve({ data: h.committedCards, error: h.cardsReadError }).then(res)
      return b
    },
  }),
}))

import { resolveThursdayBanner, canViewThursdayBanner } from '@/lib/introductions/thursdayBanner'
import { finalizeWeeklyRelease, getCurrentCycleRelease, currentCycleKey } from '@/lib/introductions/batchRelease'
import { weeklyRunKey, nextBatch, currentCycleBatch } from '@/lib/introductions/thursdaySchedule'
import { createAdminClient } from '@/lib/supabase/admin'

const MIG = readFileSync('supabase/migrations/074_weekly_batch_releases.sql', 'utf8')
const BANNER = readFileSync('lib/introductions/thursdayBanner.ts', 'utf8')
const PAGE = readFileSync('app/dashboard/introductions/page.tsx', 'utf8')
const APPROVE = readFileSync('app/api/admin/approve-batch/route.ts', 'utf8')
const WEEKLY = readFileSync('app/api/cron/weekly-refresh/route.ts', 'utf8')
const COMPONENT = readFileSync('components/ThursdayCountdownBanner.tsx', 'utf8')

// Thursday 2026-08-20 14:00 UTC is a batch window start.
const WINDOW = new Date('2026-08-20T14:00:00Z')
const BEFORE_WINDOW = new Date('2026-08-19T12:00:00Z')   // Wednesday
const AFTER_WINDOW = new Date('2026-08-21T12:00:00Z')    // Friday
const NEXT_WINDOW = new Date('2026-08-27T14:30:00Z')     // the FOLLOWING Thursday, mid-window

const view = (over: any = {}) => resolveThursdayBanner({
  now: AFTER_WINDOW, canView: true, receivedThisCycle: false, releasedThisCycle: false, ...over,
})!

const card = (requester: string) => ({ requester_id: requester })
beforeEach(() => {
  h.releaseRow = null; h.readError = null; h.inserted = []; h.insertError = null
  h.committedCards = [card('m1'), card('m1'), card('m2')]   // 3 cards, 2 members, by default
  h.cardsReadError = null
  h.facts = []; h.currentKey = 'thu-2026-08-20'; h.knownBatches = ['b1']
  h.batchMaterializedThisWindow = { b1: 3 }; h.batchMaterializedEarlier = {}
  h.weeklyCardsThisWindow = 3; h.rpcError = null; h.rpcCalls = []
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
describe('the countdown requires proof of release', () => {
  it('6. before release: neutral preparation state and NO countdown', () => {
    const v = view({ releasedThisCycle: false })
    expect(v.kind).toBe('pre_release')
    expect(v.title).toBe("This week's introduction batch is being prepared")
    expect(v.subtitle).toBe('Check back after the next batch is released.')
    expect(v.showCountdown).toBe(false)
    expect(v.initialCountdownText).toBe('')
  })

  it('7. after release: next-Thursday countdown', () => {
    const v = view({ releasedThisCycle: true })
    expect(v.kind).toBe('post_release')
    expect(v.title).toBe('Next introduction batch: Thursday')
    expect(v.subtitle).toBe('The next curated introduction batch is being prepared.')
    expect(v.showCountdown).toBe(true)
    expect(v.initialCountdownText.length).toBeGreaterThan(0)
    expect(v.targetIso).toBe(nextBatch(AFTER_WINDOW).toISOString())
  })

  it('a FAILED read is not treated as released — no countdown is invented', () => {
    const v = view({ releasedThisCycle: null })
    expect(v.kind).toBe('pre_release')
    expect(v.showCountdown).toBe(false)
  })

  it('8. at the next Thursday window it RETURNS to pre_release until a new release', () => {
    // last week's release is recorded; the key has since advanced, so `releasedThisCycle` is false
    const v = resolveThursdayBanner({
      now: NEXT_WINDOW, canView: true, receivedThisCycle: false, releasedThisCycle: false })!
    expect(v.kind).toBe('pre_release')
    expect(v.showCountdown).toBe(false)
    // and the key really did advance, so nothing can carry the old release forward
    expect(weeklyRunKey(AFTER_WINDOW)).not.toBe(weeklyRunKey(NEXT_WINDOW))
  })

  it('cannot advance Thursday-to-Thursday on its own: each week needs its own key', () => {
    const keys = [BEFORE_WINDOW, AFTER_WINDOW, NEXT_WINDOW, new Date('2026-09-03T12:00:00Z')]
      .map((d) => weeklyRunKey(d))
    expect(new Set(keys).size).toBe(3)          // Wed and Fri share a window; the next two differ
    expect(keys[2]).not.toBe(keys[1])
  })

  it('the countdown target is strictly after the current window and never negative', () => {
    for (const now of [BEFORE_WINDOW, WINDOW, AFTER_WINDOW, NEXT_WINDOW]) {
      const v = resolveThursdayBanner({ now, canView: true, receivedThisCycle: false, releasedThisCycle: true })!
      expect(new Date(v.targetIso).getTime()).toBeGreaterThan(now.getTime() - 60 * 60 * 1000)
      expect(v.initialCountdownText).not.toMatch(/-/)
    }
  })

  it('handles a year boundary and both DST sides', () => {
    for (const iso of ['2026-12-31T12:00:00Z', '2027-01-01T12:00:00Z',
                       '2026-01-15T12:00:00Z', '2026-07-15T12:00:00Z']) {
      const v = resolveThursdayBanner({ now: new Date(iso), canView: true, receivedThisCycle: false, releasedThisCycle: true })!
      const t = new Date(v.targetIso)
      expect(t.getUTCDay()).toBe(4)             // always a Thursday
      expect(t.getUTCHours()).toBe(14)          // always the 14:00 UTC window
      expect(Number.isNaN(t.getTime())).toBe(false)
    }
  })
})

describe('9-11. precedence and audience', () => {
  it('9. a member who received NO card still sees the platform-wide countdown', () => {
    const v = view({ receivedThisCycle: false, releasedThisCycle: true })
    expect(v.kind).toBe('post_release')
    expect(v.showCountdown).toBe(true)
  })

  it('10. "New introductions are here" needs the member\'s OWN server-proven card', () => {
    expect(view({ receivedThisCycle: true, releasedThisCycle: true }).kind).toBe('after_received')
    // a draft or failed batch writes no 'suggested' row for the member, so it cannot reach this
    expect(view({ receivedThisCycle: false, releasedThisCycle: true }).kind).toBe('post_release')
    expect(view({ receivedThisCycle: null, releasedThisCycle: true }).kind).toBe('post_release')
  })

  it('the page proves that card evidence from committed rows only', () => {
    expect(PAGE).toMatch(/\.eq\('status', 'suggested'\)/)
    expect(PAGE).toMatch(/\.gte\('created_at', cycleStartIso\)/)
    expect(PAGE).toMatch(/currentCycleBatch\(bannerNow\)/)
  })

  it('11. admin stays schedule-only but sees the SAME release truth', () => {
    expect(view({ receivedThisCycle: true, releasedThisCycle: false, scheduleOnly: true }).kind).toBe('pre_release')
    expect(view({ receivedThisCycle: true, releasedThisCycle: true, scheduleOnly: true }).kind).toBe('post_release')
    // scheduleOnly suppresses only the member-specific state; it never fabricates a release
    expect(PAGE).toMatch(/releasedThisCycle, scheduleOnly: true/)
  })

  it('12. excluded accounts stay hidden regardless of release state', () => {
    for (const facts of [
      { accountStatus: 'deactivated', profileComplete: true, isTestAccount: false, matchingPaused: false, isAdmin: false },
      { accountStatus: 'active', profileComplete: false, isTestAccount: false, matchingPaused: false, isAdmin: false },
      { accountStatus: 'active', profileComplete: true, isTestAccount: true, matchingPaused: false, isAdmin: false },
      { accountStatus: 'active', profileComplete: true, isTestAccount: false, matchingPaused: true, isAdmin: false },
    ]) {
      expect(canViewThursdayBanner(facts as any)).toBe(false)
      expect(resolveThursdayBanner({ now: AFTER_WINDOW, canView: false, receivedThisCycle: true, releasedThisCycle: true })).toBeNull()
    }
  })
})

describe('completion is proven by the writer, never inferred from cards', () => {
  const admin = () => createAdminClient()

  it('4. a clean completed loop with deterministic skips records ONE completed fact', async () => {
    const r = await finalizeWeeklyRelease(admin(), { source: 'admin_approval', batchId: 'b1' })
    expect(r.finalized).toBe(true)
    expect((r as any).wasExisting).toBe(false)
    expect((r as any).cardsReleased).toBe(3)
    expect(h.rpcCalls).toHaveLength(1)
    // the caller supplies NO key, NO window and NO count — none can be fabricated
    expect(Object.keys(h.rpcCalls[0].params).sort()).toEqual(['p_batch_id', 'p_source'])
  })

  it('5. zero committed cards -> the RPC refuses; the caller cannot claim success', async () => {
    h.weeklyCardsThisWindow = 0
    const r = await finalizeWeeklyRelease(admin(), { source: 'weekly_cron' })
    expect(r.finalized).toBe(false)
    expect((r as any).reason).toBe('no_visible_introductions')
    expect(h.facts).toHaveLength(0)
  })

  it('6. a lost response is safe: the retry returns the SAME fact', async () => {
    const first = await finalizeWeeklyRelease(admin(), { source: 'admin_approval', batchId: 'b1' })
    const retry = await finalizeWeeklyRelease(admin(), { source: 'weekly_cron' })
    expect(retry.finalized).toBe(true)
    expect((retry as any).wasExisting).toBe(true)
    expect((retry as any).releaseKey).toBe((first as any).releaseKey)
    expect(h.facts[0].source).toBe('admin_approval')       // first fact stands; never overwritten
  })

  it('7. a genuine finalization failure is reported, never disguised as success', async () => {
    h.rpcError = { code: '42501' }
    const r = await finalizeWeeklyRelease(admin(), { source: 'admin_approval', batchId: 'b1' })
    expect(r.finalized).toBe(false)
    expect((r as any).reason).toBe('finalize_failed')
  })

  it('a driver that throws still yields a failure result, not an exception', async () => {
    const throwing = { rpc: () => { throw new TypeError('rpc is not a function') } }
    const r = await finalizeWeeklyRelease(throwing as any, { source: 'weekly_cron' })
    expect(r.finalized).toBe(false)
    expect((r as any).reason).toBe('finalize_failed')
  })

  it('1+3. an interrupted route, or one with transient errors, never finalizes', () => {
    // approve-batch: reaching the finalize line requires the loop to have completed...
    expect(APPROVE).toMatch(/const transientFailures = byOutcome\['error'\] \?\? 0/)
    expect(APPROVE).toMatch(/if \(transientFailures > 0\) \{[\s\S]{0,120}skipped_transient_errors/)
    // ...and the finalize call is inside the ELSE branch, so a partial run cannot reach it
    const gate = APPROVE.indexOf('if (transientFailures > 0)')
    expect(gate).toBeLessThan(APPROVE.indexOf('finalizeWeeklyRelease(adminClient'))
    // weekly maintenance is not a release writer at all; only Daniel's admin Send may finalize
    expect(WEEKLY).not.toMatch(/finalizeWeeklyRelease|finalize_weekly_release/)
    expect(WEEKLY).toMatch(/admin_send_required/)
  })

  it('2+10. NOTHING infers completion from cards — no reconciliation exists anywhere', () => {
    const REL = readFileSync('lib/introductions/batchRelease.ts', 'utf8')
    expect(REL).not.toMatch(/reconcile/i)
    // the module never counts cards itself; the RPC verifies inside its own transaction
    expect(REL).not.toMatch(/\.from\('intro_requests'\)/)
    const CRON = readFileSync('app/api/cron/engagement-reminders/route.ts', 'utf8')
    expect(CRON).not.toMatch(/reconcile|weekly_batch_releases|finalizeWeeklyRelease/)
    // and the reason is recorded where the next reader will find it
    expect(REL).toMatch(/IDENTICAL in the database/)
    expect(MIG).toMatch(/VISIBLE CARDS ARE NOT PROOF OF COMPLETION/)
  })

  it('8+9. recovery is re-running the idempotent writer, and a replay finalizes safely', async () => {
    // first attempt: finalization fails
    h.rpcError = { code: '42501' }
    expect((await finalizeWeeklyRelease(admin(), { source: 'admin_approval', batchId: 'b1' })).finalized).toBe(false)
    expect(h.facts).toHaveLength(0)
    // the admin re-approves: materialisation is idempotent, the loop re-reaches its end, finalize works
    h.rpcError = null
    const retry = await finalizeWeeklyRelease(admin(), { source: 'admin_approval', batchId: 'b1' })
    expect(retry.finalized).toBe(true)
    expect((retry as any).wasExisting).toBe(false)
    // the sole writer documents that recovery is a rerun, not an inference
    expect(APPROVE).toMatch(/retry re-materialises what is\n    \/\/ missing/)
    expect(WEEKLY).toMatch(/Only\n  \/\/ approve-batch finalizes a release marker/)
  })

  it('11. the banner reads the immutable fact and nothing else', async () => {
    expect(await getCurrentCycleRelease(admin(), AFTER_WINDOW)).toBeNull()
    h.facts = [{ release_key: weeklyRunKey(AFTER_WINDOW), released_at: AFTER_WINDOW.toISOString(), source: 'weekly_cron' }]
    expect(await getCurrentCycleRelease(admin(), AFTER_WINDOW)).toBeNull() // maintenance is not Daniel's Send
    h.facts = [{ release_key: weeklyRunKey(AFTER_WINDOW), released_at: AFTER_WINDOW.toISOString(), source: 'admin_approval' }]
    expect(await getCurrentCycleRelease(admin(), AFTER_WINDOW)).not.toBeNull()
    h.readError = { code: 'PGRST' }
    expect(await getCurrentCycleRelease(admin(), AFTER_WINDOW)).toBeNull()   // fail closed
    expect(currentCycleKey(AFTER_WINDOW)).toBe(weeklyRunKey(AFTER_WINDOW))
  })

  it('there is exactly one completion value — a release completed, or was never recorded', () => {
    expect(MIG).not.toMatch(/completed_with_partial_results/)
    expect(MIG).not.toMatch(/completion\s+text/)
    const REL = readFileSync('lib/introductions/batchRelease.ts', 'utf8')
    expect(REL).not.toMatch(/completed_with_partial_results/)
  })

  it('draft generation, deletion and preview record nothing', () => {
    for (const f of ['app/api/admin/generate-batch/route.ts', 'app/api/admin/delete-batch/route.ts']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/finalizeWeeklyRelease|weekly_batch_releases|finalize_weekly_release/)
    }
    expect(MIG).toMatch(/deliberately NOT a foreign key/)
  })
})

describe('15-16. writers, wiring and scope', () => {
  it('15. only admin Send records a release, and only after cards exist', () => {
    // Admin Send does not gate on its own tally — finalizeWeeklyRelease verifies from the DB.
    expect(APPROVE).toMatch(/finalizeWeeklyRelease\(adminClient, \{ source: 'admin_approval', batchId \}\)/)
    expect(WEEKLY).not.toMatch(/finalizeWeeklyRelease|finalize_weekly_release/)
    // the admin writer does not gate on its own tally — the RPC verifies inside its own transaction
    expect(APPROVE).not.toMatch(/if \(createdVisible > 0\)/)
    // finalization happens AFTER the materialisation loop, never at the status flip
    expect(APPROVE.indexOf('materializeAdminPair(adminClient'))
      .toBeLessThan(APPROVE.indexOf('finalizeWeeklyRelease(adminClient'))
    // and the outcome is surfaced, so a failed finalization is never silently a success
    expect(APPROVE).toMatch(/releaseFinalization,/)
    expect(WEEKLY).toMatch(/releaseFinalization,/)
    // approve-batch must record AFTER the materialisation loop, never at the status flip
    const callSite = APPROVE.indexOf('finalizeWeeklyRelease(adminClient')   // not the import line
    expect(callSite).toBeGreaterThan(-1)
    expect(APPROVE.indexOf("update({ status: 'active' })")).toBeLessThan(callSite)
    expect(APPROVE.indexOf('materializeAdminPair(adminClient')).toBeLessThan(callSite)
  })

  it('the release is resolved SERVER-side and only minimal state reaches the client', () => {
    expect(PAGE).toMatch(/getCurrentCycleRelease\(createAdminClient\(\), bannerNow\)/)
    // the component receives a kind, copy, an absolute instant and a boolean — nothing else
    const props = PAGE.slice(PAGE.indexOf('<ThursdayCountdownBanner'), PAGE.indexOf('<ThursdayCountdownBanner') + 400)
    expect(props).toMatch(/kind=\{thursdayBanner\.kind\}/)
    expect(props).toMatch(/targetIso=\{thursdayBanner\.targetIso\}/)
    expect(props).not.toMatch(/releaseKey|batchId|memberId|cards_released/)
  })

  it('13. no browser database polling is introduced', () => {
    expect(COMPONENT).not.toMatch(/createClient|supabase|fetch\(|\.from\(/)
    expect(COMPONENT).toMatch(/'use client'/)
    expect(COMPONENT).toMatch(/targetIso/)          // counts down from an absolute instant only
  })

  it('14. no exact-time or guaranteed-introduction promise in any state', () => {
    const copy = [
      view({ releasedThisCycle: false }), view({ releasedThisCycle: true }),
      view({ receivedThisCycle: true, releasedThisCycle: true }),
    ].map((v) => `${v.title} ${v.subtitle}`).join(' ')
    expect(copy).not.toMatch(/\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i)
    expect(copy).not.toMatch(/guarantee|everyone|every member|you will receive|will be matched/i)
    expect(copy).not.toMatch(/have been sent|were sent|already sent/i)
  })

  it('16. nothing outside this scope was touched', () => {
    // the banner still consults no scoring, capacity, credit or expiry concept
    expect(BANNER).not.toMatch(/credit|capacity|scoring|expiry|reciprocal|notification/i)
    // and the release module writes exactly one table
    const REL = readFileSync('lib/introductions/batchRelease.ts', 'utf8')
    const tables = Array.from(REL.matchAll(/\.from\('(\w+)'\)/g)).map((m) => m[1])
    // it only READS the immutable fact; all verification and writing happen inside the RPC
    expect(new Set(tables)).toEqual(new Set(['weekly_batch_releases']))
    expect(REL).not.toMatch(/\.insert\(/)
  })

  it('CRON_SECRET and admin authorization are preserved', () => {
    expect(WEEKLY).toMatch(/Bearer \$\{process\.env\.CRON_SECRET\}/)
    expect(APPROVE).toMatch(/Not authorized/)
    expect(APPROVE.indexOf('Not authorized')).toBeLessThan(APPROVE.indexOf('finalizeWeeklyRelease(adminClient'))
  })
})

describe('the migration is minimal, additive and private', () => {
  it('holds no member, pair, card or batch content', () => {
    const ddl = MIG.slice(MIG.indexOf('CREATE TABLE'), MIG.indexOf('COMMENT ON TABLE'))
    for (const forbidden of ['member_id', 'user_id', 'pair_id', 'intro_request', 'email', 'full_name']) {
      expect(ddl, forbidden).not.toContain(forbidden)
    }
  })

  it('is idempotent by a UNIQUE weekly key', () => {
    expect(MIG).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS weekly_batch_releases_key_uniq\s*\n\s*ON public\.weekly_batch_releases \(release_key\)/)
  })

  it('gives browser roles no table access and RLS with zero policies', () => {
    expect(MIG).toMatch(/ENABLE ROW LEVEL SECURITY/)
    expect(MIG).not.toMatch(/CREATE POLICY/)
    expect(MIG).toMatch(/REVOKE ALL ON TABLE public\.weekly_batch_releases FROM anon, authenticated/)
    expect(MIG).toMatch(/GRANT SELECT, INSERT\s*\nON TABLE public\.weekly_batch_releases\s*\nTO service_role;/)
    // the only browser-reachable surface exposes a key and a timestamp, nothing else
    expect(MIG).toMatch(/RETURNS TABLE \(release_key text, released_at timestamptz\)/)
    expect(MIG).toMatch(/SET search_path = ''/)
    expect(MIG).toMatch(/SECURITY DEFINER/)
  })

  it('is additive: no destructive statement and no historical rewrite', () => {
    const code = MIG.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    // NB: TRUNCATE/UPDATE/DELETE also appear as PRIVILEGE NAMES inside the REVOKE, which is the
    // opposite of destructive. Match the statement forms only.
    expect(code).not.toMatch(/\bDROP TABLE\b|\bDELETE FROM\b|^\s*TRUNCATE\s|\bUPDATE public\./m)
    // the only INSERT is inside the finalization function, which verifies first; no backfill exists
    const outsideFn = code.slice(0, code.indexOf('CREATE OR REPLACE FUNCTION public.finalize_weekly_release'))
    expect(outsideFn).not.toMatch(/INSERT INTO public\.weekly_batch_releases/)
  })

  it('does not touch the protected migrations', () => {
    for (const n of ['048', '058', '059', '060', '063', '064', '065', '066', '067', '068',
                     '069', '070', '071', '072', '073']) {
      expect(MIG).not.toMatch(new RegExp(`migration ${n}\\b.*(ALTER|DROP)`, 'i'))
    }
    expect(MIG).toMatch(/063-073 are untouched/)
  })
})

describe('the release key is the SAME key everywhere, in every timezone', () => {
  const KEY_SOURCES = () => ({
    approve: readFileSync('app/api/admin/approve-batch/route.ts', 'utf8'),
    weekly: readFileSync('app/api/cron/weekly-refresh/route.ts', 'utf8'),
    release: readFileSync('lib/introductions/batchRelease.ts', 'utf8'),
    page: PAGE,
  })

  it('every path derives the key from ONE function, never its own arithmetic', () => {
    const { release } = KEY_SOURCES()
    // the writers and the reader all go through batchRelease, which uses weeklyRunKey exclusively
    expect(release).toMatch(/import \{ weeklyRunKey, currentCycleBatch \}/)
    const keyUses = Array.from(release.matchAll(/weeklyRunKey\(/g))
    expect(keyUses.length).toBeGreaterThanOrEqual(2)      // read + currentCycleKey
    expect(release).not.toMatch(/getUTCDay\(\)|new Date\(Date\.UTC/)   // no local key arithmetic
  })

  it('the admin path, the weekly path and the page resolve the identical key for one window', () => {
    // all four go through weeklyRunKey; equal inputs must give equal keys
    for (const iso of ['2026-08-20T14:00:00Z', '2026-08-20T14:59:59Z', '2026-08-22T03:00:00Z']) {
      const d = new Date(iso)
      expect(currentCycleKey(d)).toBe(weeklyRunKey(d))
    }
  })

  it('the key is stable across the ENTIRE Thursday invocation window', () => {
    const start = new Date('2026-08-20T14:00:00Z')
    const keys = new Set<string>()
    for (let m = 0; m < 60; m++) keys.add(weeklyRunKey(new Date(start.getTime() + m * 60_000)))
    expect(keys.size).toBe(1)                              // one key for the whole [14:00,15:00) hour
    expect(Array.from(keys)[0]).toBe('thu-2026-08-20')
  })

  it('the key is stable across EST and EDT and does not shift with the local clock', () => {
    // EDT (summer) and EST (winter) windows both anchor on their own Thursday 14:00 UTC
    expect(weeklyRunKey(new Date('2026-07-16T18:00:00Z'))).toBe('thu-2026-07-16')  // EDT
    expect(weeklyRunKey(new Date('2026-01-15T18:00:00Z'))).toBe('thu-2026-01-15')  // EST
    // the DST changeover weekend does not split a week in two
    const before = weeklyRunKey(new Date('2026-03-05T15:00:00Z'))
    const after = weeklyRunKey(new Date('2026-03-08T12:00:00Z'))                   // after clocks change
    expect(before).toBe(after)
  })

  it('the key is correct across a year boundary', () => {
    expect(weeklyRunKey(new Date('2026-12-31T20:00:00Z'))).toBe('thu-2026-12-31')
    expect(weeklyRunKey(new Date('2027-01-02T12:00:00Z'))).toBe('thu-2026-12-31')  // still that week
    expect(weeklyRunKey(new Date('2027-01-07T15:00:00Z'))).toBe('thu-2027-01-07')  // next week
  })

  it('the key changes exactly once per week, at the window boundary', () => {
    const justBefore = weeklyRunKey(new Date('2026-08-27T13:59:59Z'))
    const atWindow = weeklyRunKey(new Date('2026-08-27T14:00:00Z'))
    expect(justBefore).toBe('thu-2026-08-20')
    expect(atWindow).toBe('thu-2026-08-27')
  })
})

describe('weekly_batch_released — security contract', () => {
  it('is SECURITY DEFINER with an empty search_path and fully schema-qualified', () => {
    const fn = MIG.slice(MIG.indexOf('CREATE OR REPLACE FUNCTION public.weekly_batch_released'))
    expect(fn).toMatch(/SECURITY DEFINER/)
    expect(fn).toMatch(/SET search_path = ''/)
    expect(fn).toMatch(/STABLE/)
    const body = fn.slice(fn.indexOf('AS $fn$'), fn.indexOf('$fn$;'))
    expect(body).toMatch(/FROM public\.weekly_batch_releases r/)
    expect(body.replace(/public\.weekly_batch_releases/g, '')).not.toMatch(/\bweekly_batch_releases\b/)
  })

  it('PUBLIC and anon cannot execute; authenticated and service_role can', () => {
    expect(MIG).toMatch(/REVOKE ALL ON FUNCTION public\.weekly_batch_released\(text\) FROM PUBLIC;/)
    expect(MIG).toMatch(/REVOKE ALL ON FUNCTION public\.weekly_batch_released\(text\) FROM anon;/)
    expect(MIG).toMatch(/GRANT EXECUTE ON FUNCTION public\.weekly_batch_released\(text\) TO authenticated, service_role;/)
  })

  it('returns only the minimal release result — no counts, source, or batch id', () => {
    expect(MIG).toMatch(/RETURNS TABLE \(release_key text, released_at timestamptz\)/)
    const readerFn = MIG.slice(MIG.indexOf('CREATE OR REPLACE FUNCTION public.weekly_batch_released'))
    const body = readerFn.slice(readerFn.indexOf('AS $fn$'), readerFn.indexOf('$fn$;'))
    for (const hidden of ['cards_released', 'members_reached', 'source', 'batch_id']) {
      expect(body, hidden).not.toContain(hidden)
    }
  })

  it('no browser role holds any table privilege', () => {
    expect(MIG).toMatch(/REVOKE ALL ON TABLE public\.weekly_batch_releases FROM PUBLIC;/)
    expect(MIG).toMatch(/REVOKE ALL ON TABLE public\.weekly_batch_releases FROM anon, authenticated;/)
    expect(MIG).not.toMatch(/GRANT[^;]*ON TABLE public\.weekly_batch_releases[^;]*(anon|authenticated|PUBLIC)/)
  })

  it('service_role gets only what it needs — no UPDATE or DELETE path can rewrite a release fact', () => {
    const grants = sqlCodeOf(MIG).match(/GRANT[^;]*ON TABLE public\.weekly_batch_releases[^;]*;/g) ?? []
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatch(/GRANT SELECT, INSERT/)
    expect(grants[0]).not.toMatch(/UPDATE|DELETE|TRUNCATE|ALL/)
    // and nothing in the app ever tries
    const REL = readFileSync('lib/introductions/batchRelease.ts', 'utf8')
    expect(REL).not.toMatch(/weekly_batch_releases'\)\s*\n?\s*\.(update|delete)/)
  })

  it('a release with zero visible cards is unrepresentable in the schema', () => {
    expect(MIG).toMatch(/cards_released integer NOT NULL CHECK \(cards_released > 0\)/)
  })

  it('an interrupted run has no completion value it could be recorded under', () => {
    // there is no completion column at all: a release either exists or it does not
    expect(sqlCodeOf(MIG)).not.toMatch(/completion/)
    expect(sqlCodeOf(MIG)).not.toMatch(/'interrupted'|'partial'(?!_)/)
  })

  it('the non-atomicity limitation is stated in the migration itself', () => {
    expect(MIG).toMatch(/VISIBLE CARDS ARE NOT PROOF OF COMPLETION/)
    expect(MIG).toMatch(/the loop CRASHED halfway/)
    expect(MIG).toMatch(/NO card-based reconciliation job anywhere/)
  })

  it('NO scheduled job may repair a release from cards — the daily cron is untouched', () => {
    const CRON = readFileSync('app/api/cron/engagement-reminders/route.ts', 'utf8')
    expect(CRON).not.toMatch(/reconcile|weekly_batch_releases|finalize_weekly_release/)
  })
})

/** Strip SQL line comments so an assertion tests statements, not the prose describing them. */
function sqlCodeOf(src: string): string {
  return src.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
}

/**
 * THE RELEASE-KEY BOUNDARY. Deriving the key from now() alone is not enough: replaying an old
 * approval after the Thursday boundary would otherwise let a week-1 batch create — or satisfy —
 * week 2's release. Identity is therefore consulted BEFORE the calendar.
 */
describe('release-key boundary cases', () => {
  const admin = () => createAdminClient()
  const adminFin = (batchId: string) => finalizeWeeklyRelease(admin(), { source: 'admin_approval', batchId })

  it('1. the same admin batch finalized twice in one week yields ONE fact', async () => {
    const a = await adminFin('b1')
    const b = await adminFin('b1')
    expect(a.finalized && b.finalized).toBe(true)
    expect((a as any).wasExisting).toBe(false)
    expect((b as any).wasExisting).toBe(true)
    expect(h.facts).toHaveLength(1)
  })

  it('2. a finalized batch replayed AFTER the next boundary returns its ORIGINAL fact', async () => {
    const first = await adminFin('b1')
    expect((first as any).releaseKey).toBe('thu-2026-08-20')
    // the calendar advances a week
    h.currentKey = 'thu-2026-08-27'
    h.batchMaterializedThisWindow = {}                    // that batch materialised nothing this week
    h.batchMaterializedEarlier = { b1: 3 }
    const replay = await adminFin('b1')
    expect(replay.finalized).toBe(true)
    expect((replay as any).wasExisting).toBe(true)
    expect((replay as any).releaseKey).toBe('thu-2026-08-20')   // week 1, not week 2
    expect(h.facts).toHaveLength(1)                             // no week-2 fact manufactured
  })

  it('3. an UNFINALIZED old batch replayed after the boundary cannot create a new-week fact', async () => {
    h.currentKey = 'thu-2026-08-27'
    h.batchMaterializedThisWindow = {}
    h.batchMaterializedEarlier = { b1: 3 }
    const r = await adminFin('b1')
    expect(r.finalized).toBe(false)
    expect((r as any).reason).toBe('batch_belongs_to_earlier_window')
    expect(h.facts).toHaveLength(0)
  })

  it('4. current finalization with only OLD cards is refused explicitly', async () => {
    h.weeklyCardsThisWindow = 0
    const r = await finalizeWeeklyRelease(admin(), { source: 'weekly_cron' })
    expect((r as any).reason).toBe('no_visible_introductions')
    expect(h.facts).toHaveLength(0)
  })

  it('5. an unrelated or invented batch_id is rejected', async () => {
    const r = await adminFin('not-a-real-batch')
    expect(r.finalized).toBe(false)
    expect((r as any).reason).toBe('batch_not_found')
  })

  it('6+7. contract violations are rejected', async () => {
    const noBatch = await finalizeWeeklyRelease(admin(), { source: 'admin_approval' })
    expect((noBatch as any).reason).toBe('admin_requires_batch_id')
    const weeklyWithBatch = await finalizeWeeklyRelease(admin(), { source: 'weekly_cron', batchId: 'b1' })
    expect((weeklyWithBatch as any).reason).toBe('weekly_forbids_batch_id')
    const bogus = await finalizeWeeklyRelease(admin(), { source: 'nope' as any })
    expect((bogus as any).reason).toBe('invalid_source')
    expect(h.facts).toHaveLength(0)
  })

  it('E. new cards belonging to a DIFFERENT batch cannot finalize this one', async () => {
    h.knownBatches = ['b1', 'b2']
    h.batchMaterializedThisWindow = { b1: 3 }        // b2 materialised nothing
    const r = await adminFin('b2')
    expect(r.finalized).toBe(false)
    expect((r as any).reason).toBe('no_visible_introductions')
  })

  it('8+9. uniqueness is enforced by the DATABASE, not by the function', () => {
    // one batch cannot own two keys; one key cannot be owned twice
    expect(MIG).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS weekly_batch_releases_batch_uniq\s*\n\s*ON public\.weekly_batch_releases \(batch_id\)\s*\n\s*WHERE batch_id IS NOT NULL/)
    expect(MIG).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS weekly_batch_releases_key_uniq/)
  })

  it('the identity lookup happens BEFORE the calendar is consulted', () => {
    const fn = MIG.slice(MIG.indexOf('AS $fn$'), MIG.indexOf('$fn$;'))
    expect(fn.indexOf('WHERE r.batch_id = p_batch_id'))
      .toBeLessThan(fn.indexOf("v_key := 'thu-'"))
    expect(fn).toMatch(/IDENTITY BEFORE CALENDAR/)
  })

  it('evidence is scoped to the exact writer and window, never "a card exists somewhere"', () => {
    const fn = MIG.slice(MIG.indexOf('AS $fn$'), MIG.indexOf('$fn$;'))
    // admin: this review batch, materialised inside this window, still visible
    expect(fn).toMatch(/FROM public\.batch_suggestions bs/)
    expect(fn).toMatch(/bs\.batch_id = p_batch_id/)
    expect(fn).toMatch(/bs\.materialized_at >= v_window_start/)
    // weekly: the weekly writer's own PAIRS, inside this window — not "any non-admin card"
    expect(fn).toMatch(/mp\.source = 'weekly'/)
    expect(fn).toMatch(/mp\.last_recommended_at >= v_window_start/)
  })

  it('the migration states plainly what could NOT be used for attribution', () => {
    expect(MIG).toMatch(/no column on intro_requests references the review batch/)
    expect(MIG).toMatch(/does not pretend/)
    expect(MIG).toMatch(/reciprocal_batch_id is also unusable/)
  })

  it('11. the boundary returns the banner to pre_release until a NEW release finalizes', async () => {
    // week 1 released -> countdown
    await adminFin('b1')
    h.readError = null
    expect((await getCurrentCycleRelease(admin(), AFTER_WINDOW))).not.toBeNull()
    expect(view({ releasedThisCycle: true }).kind).toBe('post_release')
    // the calendar advances: the key has no fact, so the banner goes neutral again
    h.currentKey = 'thu-2026-08-27'
    expect(await getCurrentCycleRelease(admin(), NEXT_WINDOW)).toBeNull()
    expect(view({ releasedThisCycle: false }).kind).toBe('pre_release')
    expect(view({ releasedThisCycle: false }).showCountdown).toBe(false)
  })
})

/**
 * WEEKLY ATTRIBUTION. `is_admin_initiated IS NOT TRUE` was too broad — every non-admin producer
 * writes it, so an onboarding card would have qualified a weekly release. member_pairs.source is the
 * durable discriminator, and generate-recommendations.ts:1179 maps generation source to it.
 */
describe('weekly evidence is scoped to the weekly writer', () => {
  const fn = () => MIG.slice(MIG.indexOf('AS $fn$'), MIG.indexOf('$fn$;'))

  it('keys on member_pairs.source = weekly, not on the admin flag', () => {
    expect(fn()).toMatch(/mp\.source = 'weekly'/)
    // the regression this replaces: the flag must not appear as attribution anywhere
    expect(fn()).not.toMatch(/is_admin_initiated/)
  })

  it('is window-scoped on an immutable recommendation instant', () => {
    expect(fn()).toMatch(/mp\.last_recommended_at >= v_window_start/)
  })

  it('requires a healthy two-sided reciprocal pair', () => {
    expect(fn()).toMatch(/x\.pair_id = mp\.id AND x\.created_at >= v_window_start\) = 2/)
  })

  it('never rests on the mutable card status — a member may act before finalization', () => {
    expect(fn()).not.toMatch(/ir\.status|status = 'suggested'/)
    expect(MIG).toMatch(/EVIDENCE MUST NOT DEPEND ON A MUTABLE STATUS/)
    // admin evidence is the immutable materialisation stamp, with no status join
    expect(fn()).toMatch(/bs\.materialized_at >= v_window_start/)
  })

  it('records the full writer inventory and the coverage decision', () => {
    expect(MIG).toMatch(/WRITER INVENTORY/)
    for (const w of ['weekly-refresh broad generation', 'weekly-refresh COVERAGE generation',
                     'onboarding-retry-worker', 'queue promotion', 'legacy / user-requested']) {
      expect(MIG, w).toContain(w)
    }
    expect(MIG).toMatch(/COVERAGE IS PART OF THE WEEKLY RELEASE/)
    expect(MIG).toMatch(/Onboarding and retry are\n-- excluded/)
  })

  it('the app maps generation source to the pair source exactly once', () => {
    const GEN = readFileSync('lib/generate-recommendations.ts', 'utf8')
    expect(GEN).toMatch(/const pairSource = source === 'weekly' \? 'weekly' : 'onboarding'/)
    // and both weekly-refresh call sites pass 'weekly', so coverage lands in the weekly bucket
    expect((WEEKLY.match(/generateReciprocalBatchForMember\(user\.id, 'weekly'\)/g) ?? []).length).toBe(2)
  })
})

/**
 * THE INHERITED-GRANT DEFECT, for the third time.
 *
 * Migration 074's narrow `GRANT SELECT, INSERT ... TO service_role` could not remove UPDATE and
 * DELETE that Supabase's ALTER DEFAULT PRIVILEGES had already handed the role at CREATE TABLE time.
 * Production confirmed it after 074 was applied. The same defect required 071 (introduction_email_
 * outbox) and 073 (credit_transactions): a GRANT is additive, and only REVOKE removes.
 *
 * It matters here because the release fact drives the member-facing countdown. A role able to
 * rewrite or delete one could silently change what members are told about the week.
 */
describe('074 service_role privileges are corrected explicitly', () => {
  const code = () => sqlCodeOf(MIG)

  it('REVOKEs the five unwanted privileges by name, before granting', () => {
    expect(code()).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER\s*\nON TABLE public\.weekly_batch_releases\s*\nFROM service_role;/)
    const revoke = code().indexOf('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    const grant = code().indexOf('GRANT SELECT, INSERT\nON TABLE public.weekly_batch_releases')
    expect(revoke).toBeGreaterThan(-1)
    expect(grant).toBeGreaterThan(-1)
    expect(revoke).toBeLessThan(grant)          // order is the whole fix
  })

  it('grants service_role exactly SELECT and INSERT — nothing wider', () => {
    const grants = code().match(/GRANT[^;]*ON TABLE public\.weekly_batch_releases[^;]*;/g) ?? []
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatch(/GRANT SELECT, INSERT/)
    expect(grants[0]).not.toMatch(/UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL/)
    expect(grants[0]).toMatch(/TO service_role;/)
  })

  it('the revoke comes AFTER the table exists, so it can act on inherited grants', () => {
    expect(code().indexOf('CREATE TABLE IF NOT EXISTS public.weekly_batch_releases'))
      .toBeLessThan(code().indexOf('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))
  })

  it('explains the cause, so the next person does not reintroduce it', () => {
    expect(MIG).toMatch(/GRANT below is additive/)
    expect(MIG).toMatch(/ALTER DEFAULT PRIVILEGES/)
    expect(MIG).toMatch(/migrations 071 .* and 073|071 \(introduction_email_outbox\) and 073/)
  })

  it('the post-apply audit checks ALL SEVEN privileges individually', () => {
    const POST = readFileSync('supabase/audits/postapply_074.sql', 'utf8')
      const expectations: Array<[string, string]> = [
        ['SELECT', 'true'], ['INSERT', 'true'], ['UPDATE', 'false'], ['DELETE', 'false'],
        ['TRUNCATE', 'false'], ['REFERENCES', 'false'], ['TRIGGER', 'false'],
      ]
      for (const [verb, expected] of expectations) {
        const marker = `'service_role','public.weekly_batch_releases','${verb}')::text, '${expected}'`
        expect(POST.includes(marker), `${verb} must be asserted as ${expected}`).toBe(true)
      }
  })

  it('release behaviour, schema and evidence predicates are untouched by this correction', () => {
    // the finalizer still derives its own window, scopes evidence, and refuses explicitly
    expect(MIG).toMatch(/IDENTITY BEFORE CALENDAR/)
    expect(MIG).toMatch(/mp\.source = 'weekly'/)
    expect(MIG).toMatch(/bs\.materialized_at >= v_window_start/)
    expect(MIG).toMatch(/no_visible_introductions/)
    expect(MIG).toMatch(/batch_belongs_to_earlier_window/)
    // and no backfill was introduced
    const outsideFn = code().slice(0, code().indexOf('CREATE OR REPLACE FUNCTION public.finalize_weekly_release'))
    expect(outsideFn).not.toMatch(/INSERT INTO public\.weekly_batch_releases/)
  })
})
