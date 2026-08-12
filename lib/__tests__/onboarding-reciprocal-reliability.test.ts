import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { classifyGenerationOutcome, retryableFor, walkCandidates, WALK_LIMITS, GEN_TIME_BUDGET_MS } from '@/lib/generate-recommendations'
import { anySignal, boundedFetch } from '@/lib/supabase/admin'
import type { ReciprocalOutcome } from '@/lib/matching/createReciprocalSuggestion'

// ── Outcome correctness: no reason is ever erased ─────────────────────────────────────
describe('classifyGenerationOutcome', () => {
  const base = { createdCount: 0, candidatesEmpty: false, memberIneligible: false, timedOut: false }
  const c = (final: ReciprocalOutcome[], o: Partial<typeof base> = {}) => classifyGenerationOutcome(final, { ...base, ...o })

  it('created wins', () => expect(c(['error', 'created'], { createdCount: 1 })).toBe('created'))
  it('the NEW member being ineligible → ineligible', () => expect(c([], { memberIneligible: true })).toBe('ineligible'))
  it('zero candidates → empty_pool', () => expect(c([], { candidatesEmpty: true })).toBe('empty_pool'))
  it('a timeout is uncertain → transient_error (never a definitive empty)', () => expect(c(['capacity'], { timedOut: true })).toBe('transient_error'))
  it('a mixture of deterministic skips + one isolated error → transient_error (not empty/definitive)', () => {
    expect(c(['capacity', 'ineligible', 'error'])).toBe('transient_error')
    expect(c(['error'])).toBe('transient_error')
  })
  it('every safe attempt blocked by capacity/exists_active → capacity', () => {
    expect(c(['capacity', 'exists_active'])).toBe('capacity')
  })
  it('deterministic non-capacity rejections → no_compatible_candidate', () => {
    expect(c(['ineligible', 'cooldown', 'invalid'])).toBe('no_compatible_candidate')
    expect(c(['capacity', 'ineligible'])).toBe('no_compatible_candidate') // mixed deterministic, not all-capacity
  })
})

describe('retryableFor', () => {
  it('retryable: transient_error / capacity / empty_pool / no_compatible_candidate', () => {
    for (const o of ['transient_error', 'capacity', 'empty_pool', 'no_compatible_candidate'] as const) expect(retryableFor(o)).toBe(true)
  })
  it('terminal: created / noop_at_capacity / ineligible', () => {
    for (const o of ['created', 'noop_at_capacity', 'ineligible'] as const) expect(retryableFor(o)).toBe(false)
  })
})

// ── walkCandidates: bounded traversal, transient-only retry, caps, timeout ────────────
describe('walkCandidates', () => {
  const LIM = { maxRpcCalls: 12, maxCandidateAttempts: 2, timeBudgetMs: 4000, backoffMs: 0 }
  const noSleep = async () => {}
  const fixedClock = () => 1000

  // scripted createFn: outcomes per id (array = successive calls), records call counts
  function scripted(map: Record<string, ReciprocalOutcome | ReciprocalOutcome[]>) {
    const calls: Record<string, number> = {}
    const fn = async (id: string): Promise<ReciprocalOutcome> => {
      const n = (calls[id] = (calls[id] ?? 0) + 1)
      const v = map[id]
      return Array.isArray(v) ? (v[Math.min(n - 1, v.length - 1)]) : v
    }
    return { fn, calls }
  }

  it('continues past capacity/exists_active — a LATER candidate can still create', async () => {
    const { fn } = scripted({ a: 'capacity', b: 'exists_active', c: 'created' })
    const r = await walkCandidates(['a', 'b', 'c'], 1, fn, fixedClock, noSleep, LIM)
    expect(r.created).toBe(1)
    expect(r.considered).toBe(3)
    expect(classifyGenerationOutcome(r.finalOutcomes, { createdCount: r.created, candidatesEmpty: false, memberIneligible: false, timedOut: r.timedOut })).toBe('created')
  })

  it('retries ONLY the transient-failed candidate (deterministic skips are never retried)', async () => {
    const { fn, calls } = scripted({ a: ['error', 'created'], b: 'ineligible', c: 'created' })
    const r = await walkCandidates(['a', 'b', 'c'], 2, fn, fixedClock, noSleep, LIM)
    expect(calls.a).toBe(2) // transient → retried once
    expect(calls.b).toBe(1) // deterministic → NOT retried
    expect(calls.c).toBe(1)
    expect(r.created).toBe(2)
  })

  it('bounds total RPC calls at maxRpcCalls', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `c${i}`)
    const { fn } = scripted(Object.fromEntries(ids.map((id) => [id, 'capacity' as ReciprocalOutcome])))
    const r = await walkCandidates(ids, 5, fn, fixedClock, noSleep, { ...LIM, maxRpcCalls: 3 })
    expect(r.rpcCalls).toBe(3)
    expect(r.considered).toBe(3)
  })

  it('stops when the wall-clock time budget expires → timedOut, no further work', async () => {
    let t = 0
    const clock = () => (t += 2000) // each call advances 2s; budget 4s → exceeds during pass 1
    const ids = ['a', 'b', 'c', 'd', 'e']
    const { fn, calls } = scripted(Object.fromEntries(ids.map((id) => [id, 'capacity' as ReciprocalOutcome])))
    const r = await walkCandidates(ids, 5, fn, clock, noSleep, { ...LIM, timeBudgetMs: 4000 })
    expect(r.timedOut).toBe(true)
    expect(Object.keys(calls).length).toBeLessThan(ids.length) // did not process everyone
  })

  it('does NOT retry a transient candidate once the time budget is gone', async () => {
    // clock: pass-1 within budget, then jumps past deadline before the retry pass
    const seq = [0, 100, 200, 5000, 5000, 5000]
    let i = 0
    const clock = () => seq[Math.min(i++, seq.length - 1)]
    const { fn, calls } = scripted({ a: 'error' })
    const r = await walkCandidates(['a'], 1, fn, clock, noSleep, { ...LIM, timeBudgetMs: 4000 })
    expect(calls.a).toBe(1)       // no retry — deadline passed
    expect(r.created).toBe(0)
  })
})

// ── Real cancellation: every DB op is bound to the deadline via the client's fetch ────
describe('deadline propagation — boundedFetch / anySignal', () => {
  it('anySignal aborts when ANY input signal fires', () => {
    const a = new AbortController(); const b = new AbortController()
    const s = anySignal([a.signal, b.signal])
    expect(s.aborted).toBe(false)
    b.abort()
    expect(s.aborted).toBe(true)
  })

  it('a never-resolving request IS cancelled when the deadline signal fires (proves eligibility/capacity/ranker/RPC cancellation)', async () => {
    const deadline = new AbortController()
    // base fetch models a hung DB op that only settles when its signal aborts.
    const base = ((_url: any, init?: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })) as unknown as typeof fetch
    const f = boundedFetch(deadline.signal, base)
    const p = f('https://db/x' as any)
    let rejected = false
    p.catch(() => { rejected = true })
    deadline.abort()               // deadline fires → the in-flight request is aborted
    await Promise.resolve(); await Promise.resolve()
    expect(rejected).toBe(true)
  })

  it('merges the deadline signal with a per-request signal (both can cancel)', () => {
    const deadline = new AbortController(); const perReq = new AbortController()
    let captured: AbortSignal | null = null
    const base = ((_u: any, init?: any) => { captured = init.signal; return Promise.resolve('ok' as any) }) as unknown as typeof fetch
    boundedFetch(deadline.signal, base)('https://db/y' as any, { signal: perReq.signal } as any)
    expect(captured).not.toBeNull()
    perReq.abort()
    expect(captured!.aborted).toBe(true) // per-request abort also propagates
  })
})

describe('walkCandidates — deadline & ambiguous-RPC safety', () => {
  const LIM = { maxRpcCalls: 8, maxCandidateAttempts: 2, timeBudgetMs: 4000, backoffMs: 0 }
  const noSleep = async () => {}
  const clk = () => 1000
  function scripted(map: Record<string, ReciprocalOutcome | ReciprocalOutcome[]>) {
    const calls: Record<string, number> = {}
    const fn = async (id: string): Promise<ReciprocalOutcome> => {
      const n = (calls[id] = (calls[id] ?? 0) + 1)
      const v = map[id]; return Array.isArray(v) ? v[Math.min(n - 1, v.length - 1)] : v
    }
    return { fn, calls }
  }

  it('does NOT start a candidate once the deadline signal is aborted (no later candidate after deadline)', async () => {
    const ctrl = new AbortController()
    const calls: string[] = []
    const fn = async (id: string): Promise<ReciprocalOutcome> => { calls.push(id); ctrl.abort(); return 'capacity' }
    const r = await walkCandidates(['a', 'b', 'c'], 3, fn, clk, noSleep, LIM, ctrl.signal)
    expect(calls).toEqual(['a'])   // b, c never started — signal aborted after 'a'
    expect(r.timedOut).toBe(true)
  })

  it('an ambiguous timed-out RPC ("error") then exists_active on retry stays idempotent (no duplicate)', async () => {
    const { fn, calls } = scripted({ a: ['error', 'exists_active'] })
    const r = await walkCandidates(['a'], 1, fn, clk, noSleep, LIM)
    expect(calls.a).toBe(2)        // retried once
    expect(r.created).toBe(0)      // the aborted RPC may have committed; retry sees exists_active — no 2nd pair
    const outcome = classifyGenerationOutcome(r.finalOutcomes, { createdCount: r.created, candidatesEmpty: false, memberIneligible: false, timedOut: r.timedOut })
    expect(outcome).toBe('capacity') // safe/definite; NOT a duplicate creation
  })
})

// ── Structural: bounded, single-member, no sweep, no one-sided fallback, privacy ──────
describe('generator structure + safety', () => {
  const src = readFileSync('lib/generate-recommendations.ts', 'utf8')
  const gen = src.slice(src.indexOf('export async function generateReciprocalBatchForMember'))

  it('the broad retry cron route was REMOVED (no global sweep exists)', () => {
    expect(existsSync('app/api/cron/onboarding-recs-retry/route.ts')).toBe(false)
  })
  it('targets the single member (own eligibility + own capacity), never scans profiles for retry', () => {
    expect(gen).toContain(".eq('id', userId)")            // own profile
    expect(gen).toContain('isEligibleMember(me)')          // member-eligibility short-circuit
    expect(gen).toContain(".eq('requester_id', userId)")   // own capacity
    expect(gen).not.toMatch(/applyMemberEligibility/)      // no eligible-population sweep in the entry point
  })
  it('enforces hard caps (RPC calls=8, per-candidate attempts=2, time budget)', () => {
    expect(src).toContain('export const WALK_LIMITS')
    expect(WALK_LIMITS.maxCandidateAttempts).toBe(2)       // initial + one retry (not three)
    expect(WALK_LIMITS.maxRpcCalls).toBe(8)                // lowered from 12 (4× the 2-card target)
    expect(WALK_LIMITS.timeBudgetMs).toBe(GEN_TIME_BUDGET_MS)
    expect(GEN_TIME_BUDGET_MS).toBe(4000)
  })
  it('establishes ONE deadline + a deadline-bound admin client that binds every DB op', () => {
    expect(gen).toContain('new AbortController()')
    expect(gen).toContain('setTimeout(() => controller.abort(), GEN_TIME_BUDGET_MS)')
    expect(gen).toContain('createAdminClient({ signal: controller.signal })')
    // ranker receives the SAME bound client → its reads are cancellable too
    expect(gen).toContain('rankCandidatesForUser(userId, RECIPROCAL_CANDIDATE_POOL, adminClient)')
    // no timer/promise outlives the response
    expect(gen).toContain('clearTimeout(timer)')
    expect(gen).toMatch(/finally\s*\{[\s\S]*controller\.abort\(\)/)
  })
  it('creates only via the transactional RPC — NEVER a one-sided intro_requests insert', () => {
    expect(gen).toContain('createReciprocalSuggestion(adminClient, userId, id')
    expect(gen).not.toMatch(/from\('intro_requests'\)[\s\S]{0,60}\.insert/)
    expect(gen).not.toMatch(/from\('matches'\)[\s\S]{0,60}\.insert/)
  })
  it('logs a non-identifying correlation token and no identifiers', () => {
    expect(src).toContain('nextCorrelationId()')
    expect(src).toContain("console.log('[reciprocal-gen]', JSON.stringify({ event, source, ...fields }))")
    const calls = src.match(/logReciprocalGeneration\([^)]*\)/g) ?? []
    for (const call of calls) expect(call).not.toMatch(/email|\.id\b|requester_id|target_user_id|pair_id|full_name/i)
  })
})

// ── Wiring: both completion writers await the shared entry point; no redirect before it ─
describe('onboarding completion wiring', () => {
  const actions = readFileSync('app/actions.ts', 'utf8')
  const route = readFileSync('app/api/profile/complete/route.ts', 'utf8')
  const form = readFileSync('components/OnboardingForm.tsx', 'utf8')

  it('completeOnboarding awaits generation before returning', () => {
    const genIdx = actions.indexOf('await generateOnboardingRecommendations(user.id)')
    const start = actions.indexOf('export async function completeOnboarding')
    const ret = actions.indexOf('return { success: true }', start)
    expect(genIdx).toBeGreaterThan(start)
    expect(genIdx).toBeLessThan(ret)
    expect(actions).toContain('outcome: result.outcome')
  })
  it('/api/profile/complete awaits generation + logs outcome', () => {
    expect(route).toContain('await generateOnboardingRecommendations(user.id)')
    expect(route).toContain('outcome: result.outcome')
  })
  it('OnboardingForm navigates only AFTER the awaited completion (no redirect before generation)', () => {
    expect(form.indexOf("router.push('/dashboard/introductions')")).toBeGreaterThan(form.indexOf('await completeOnboarding(fd)'))
  })
  it('neither path claims a specific transient cause or blocks the member', () => {
    expect(actions).not.toMatch(/transient (blip|failure) (occurred|hit)/i)
    expect(actions).toContain('retryable: result.retryable')
    expect(route).toContain('retryable: result.retryable')
  })
})
