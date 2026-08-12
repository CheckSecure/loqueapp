import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  isRetryableOutcome, outcomeToReason, backoffSeconds, decideRetryOutcome,
  enqueueOnboardingRetry, MAX_ATTEMPTS, MAX_AGE_MS,
} from '@/lib/onboarding/retryQueue'
import type { GenerationOutcome } from '@/lib/generate-recommendations'

const NOW = Date.parse('2026-08-12T12:00:00Z')
const job = (o: Partial<{ attempt_count: number; cycle_started_at: string }> = {}) => ({ attempt_count: 0, cycle_started_at: new Date(NOW).toISOString(), ...o })

// ── PURE: which outcomes retry, and how ───────────────────────────────────────────────
describe('retryability + reason mapping', () => {
  it('only capacity/empty_pool/no_compatible_candidate/transient_error are retryable', () => {
    for (const o of ['capacity', 'empty_pool', 'no_compatible_candidate', 'transient_error'] as GenerationOutcome[]) {
      expect(isRetryableOutcome(o)).toBe(true)
      expect(outcomeToReason(o)).toBe(o)
    }
    for (const o of ['created', 'noop_at_capacity', 'ineligible'] as GenerationOutcome[]) {
      expect(isRetryableOutcome(o)).toBe(false)
      expect(outcomeToReason(o)).toBeNull()
    }
  })
})

describe('backoffSeconds — increasing + bounded, transient shorter', () => {
  it('increases with attempt and is capped', () => {
    const a = backoffSeconds('capacity', 0), b = backoffSeconds('capacity', 2), c = backoffSeconds('capacity', 40)
    expect(b).toBeGreaterThan(a)
    expect(c).toBeLessThanOrEqual(24 * 60 * 60 * 1.1) // capped ≈ 24h (+ ≤10% spread)
  })
  it('transient backs off SOONER than capacity at the same attempt', () => {
    expect(backoffSeconds('transient_error', 3)).toBeLessThan(backoffSeconds('capacity', 3))
  })
})

// ── PURE: worker decision / state machine ─────────────────────────────────────────────
describe('decideRetryOutcome', () => {
  const d = (outcome: GenerationOutcome, ctx: Partial<{ hasActiveReciprocalOpportunity: boolean }> = {}, j = job()) =>
    decideRetryOutcome(j, outcome, { now: NOW, hasActiveReciprocalOpportunity: false, ...ctx })

  it('created → completed', () => expect(d('created').patch.status).toBe('completed'))
  it('ineligible → terminal (terminal_ineligible)', () => {
    const r = d('ineligible'); expect(r.event).toBe('terminal_ineligible'); expect(r.patch.status).toBe('terminal')
  })
  it('noop_at_capacity WITH an ACTIVE reciprocal card → completed', () => {
    expect(d('noop_at_capacity', { hasActiveReciprocalOpportunity: true }).patch.status).toBe('completed')
  })
  it('noop_at_capacity WITHOUT an active reciprocal card → reschedule as capacity (never false-complete)', () => {
    const r = d('noop_at_capacity', { hasActiveReciprocalOpportunity: false })
    expect(r.event).toBe('rescheduled_capacity')
    expect(r.patch.status).toBe('pending')
    expect(r.patch.attempt_count).toBe(1)
  })
  it('capacity/empty/no_compatible/transient reschedule pending with incremented attempt + future time', () => {
    for (const [o, ev] of [['capacity', 'rescheduled_capacity'], ['empty_pool', 'rescheduled_empty'], ['no_compatible_candidate', 'rescheduled_empty'], ['transient_error', 'rescheduled_transient']] as const) {
      const r = d(o)
      expect(r.event).toBe(ev)
      expect(r.patch.status).toBe('pending')
      expect(r.patch.attempt_count).toBe(1)
      expect(Date.parse(r.patch.next_attempt_at!)).toBeGreaterThan(NOW)
    }
  })
  it('backoff grows across attempts', () => {
    const t1 = Date.parse(d('capacity', {}, job({ attempt_count: 1 })).patch.next_attempt_at!) - NOW
    const t3 = Date.parse(d('capacity', {}, job({ attempt_count: 3 })).patch.next_attempt_at!) - NOW
    expect(t3).toBeGreaterThan(t1)
  })
  it('reaching MAX_ATTEMPTS → terminal_exhausted (manual review, not retried forever)', () => {
    const r = d('capacity', {}, job({ attempt_count: MAX_ATTEMPTS - 1 }))
    expect(r.event).toBe('terminal_exhausted'); expect(r.patch.status).toBe('terminal')
  })
  it('exceeding MAX_AGE (measured from cycle_started_at, NOT created_at) → terminal_exhausted', () => {
    const old = new Date(NOW - MAX_AGE_MS - 1).toISOString()
    expect(d('capacity', {}, job({ attempt_count: 1, cycle_started_at: old })).event).toBe('terminal_exhausted')
  })
  it('a stale created_at but a FRESH cycle_started_at (resurrected job) is NOT age-exhausted', () => {
    // A resurrected completed/terminal row keeps its old created_at but gets a fresh cycle → the age
    // clock restarts, so a single new failure reschedules rather than immediately terminating.
    const fresh = new Date(NOW).toISOString()
    const r = d('capacity', {}, job({ attempt_count: 1, cycle_started_at: fresh }))
    expect(r.event).toBe('rescheduled_capacity')
    expect(r.patch.status).toBe('pending')
  })
})

// ── Enqueue rules (fail-open IO) ──────────────────────────────────────────────────────
function fakeAdmin(opts: { rpcError?: boolean } = {}) {
  const rpcCalls: Array<{ fn: string; args: any }> = []
  const admin: any = {
    rpc: async (fn: string, args: any) => { rpcCalls.push({ fn, args }); return { data: null, error: opts.rpcError ? { code: 'XX000' } : null } },
    _rpc: () => rpcCalls,
  }
  return admin
}
describe('enqueueOnboardingRetry — only a specific retryable member', () => {
  it('enqueues via the upsert RPC on a retryable outcome (reason + backoff)', async () => {
    const a = fakeAdmin()
    expect(await enqueueOnboardingRetry(a, 'u1', 'capacity')).toBe(true)
    expect(a._rpc()).toHaveLength(1)
    expect(a._rpc()[0].fn).toBe('enqueue_onboarding_retry')
    expect(a._rpc()[0].args.p_user_id).toBe('u1')
    expect(a._rpc()[0].args.p_reason).toBe('capacity')
    expect(a._rpc()[0].args.p_backoff_seconds).toBeGreaterThan(0)
  })
  it('does NOT enqueue a successful/terminal outcome', async () => {
    const a = fakeAdmin()
    for (const o of ['created', 'noop_at_capacity', 'ineligible'] as GenerationOutcome[]) expect(await enqueueOnboardingRetry(a, 'u', o)).toBe(false)
    expect(a._rpc()).toHaveLength(0)
  })
  it('fails OPEN when the RPC errors (pre-migration / transient) — never throws', async () => {
    const a = fakeAdmin({ rpcError: true })
    expect(await enqueueOnboardingRetry(a, 'u', 'transient_error')).toBe(false)
  })
})

// ── Worker behavior (real retryQueue IO + mocked admin/generator) ─────────────────────
let workerAdmin: any
const genMock = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => workerAdmin }))
vi.mock('@/lib/generate-recommendations', () => ({ generateReciprocalBatchForMember: (...a: any[]) => genMock(...a) }))
import { GET } from '@/app/api/cron/onboarding-retry-worker/route'
import { WORKER_LIMIT } from '@/lib/onboarding/retryQueue'

function makeWorkerAdmin(jobs: any[], opts: { claimError?: boolean; activeCard?: boolean; matched?: boolean; updateError?: boolean } = {}) {
  const updates: Array<{ user: string; patch: any }> = []
  const reads: string[] = []
  const claimArgs: any[] = []
  const admin: any = {
    _updates: () => updates, _reads: () => reads, _claimArgs: () => claimArgs,
    rpc: async (fn: string, args: any) => {
      if (fn === 'claim_onboarding_retries') { claimArgs.push(args); return { data: opts.claimError ? null : jobs, error: opts.claimError ? { message: 'e' } : null } }
      return { data: null, error: null }
    },
    from(table: string) {
      reads.push(table)
      let patch: any = null; const eqs: any = {}
      const b: any = {
        select: () => b, or: () => b, limit: () => b, not: () => b, in: () => b,
        eq: (c: string, v: any) => { eqs[c] = v; return b },
        update: (p: any) => { patch = p; return b },
        then: (res: any, rej: any) => {
          if (table === 'intro_requests') return Promise.resolve({ data: opts.activeCard ? [{ status: 'suggested' }] : [], error: null }).then(res, rej)
          if (table === 'member_pairs') return Promise.resolve({ data: opts.matched ? [{ id: 'p' }] : [], error: null }).then(res, rej)
          if (table === 'onboarding_recommendation_retries' && patch) {
            updates.push({ user: eqs.user_id, patch })
            return Promise.resolve({ error: opts.updateError ? { code: 'XX000' } : null }).then(res, rej)
          }
          return Promise.resolve({ data: null, error: null }).then(res, rej)
        },
      }
      return b
    },
  }
  return admin
}
const cronReq = () => ({ headers: new Headers({ authorization: `Bearer ${process.env.CRON_SECRET ?? ''}` }) }) as any

describe('onboarding-retry worker', () => {
  beforeEach(() => { genMock.mockReset(); process.env.CRON_SECRET = 'test-secret' })

  it('rejects a request without the CRON secret', async () => {
    workerAdmin = makeWorkerAdmin([])
    const res = await GET({ headers: new Headers({}) } as any)
    expect(res.status).toBe(401)
  })

  it('claims with the hard limit, processes sequentially, NEVER scans profiles', async () => {
    const jobs = [job2('a'), job2('b'), job2('c')]
    workerAdmin = makeWorkerAdmin(jobs)
    genMock.mockImplementation(async (id: string) => ({ outcome: id === 'a' ? 'created' : 'capacity', count: id === 'a' ? 1 : 0, retryable: id !== 'a', considered: 0, rpcCalls: 0 }))
    const res = await GET(cronReq())
    const body = await res.json()
    expect(workerAdmin._claimArgs()[0].p_limit).toBe(WORKER_LIMIT)      // hard-capped claim
    expect(genMock.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']) // sequential, in order
    expect(genMock.mock.calls.every((c) => c[1] === 'onboarding_retry')).toBe(true)
    expect(workerAdmin._reads()).not.toContain('profiles')             // NO profile scan
    expect(body.claimed).toBe(3); expect(body.completed).toBe(1); expect(body.rescheduled_capacity).toBe(2)
  })

  it('records outcomes durably: created→completed, transient→rescheduled_transient, ineligible→terminal', async () => {
    const jobs = [job2('a'), job2('b'), job2('c')]
    workerAdmin = makeWorkerAdmin(jobs)
    genMock.mockImplementation(async (id: string) => ({ outcome: id === 'a' ? 'created' : id === 'b' ? 'transient_error' : 'ineligible', count: 0, retryable: id === 'b' }))
    const body = await (await GET(cronReq())).json()
    expect(body.completed).toBe(1); expect(body.rescheduled_transient).toBe(1); expect(body.terminal_ineligible).toBe(1)
    const byUser = Object.fromEntries(workerAdmin._updates().map((u: any) => [u.user, u.patch.status]))
    expect(byUser).toEqual({ a: 'completed', b: 'pending', c: 'terminal' })
  })

  it('noop_at_capacity with an ACTIVE reciprocal card → completed', async () => {
    workerAdmin = makeWorkerAdmin([job2('a')], { activeCard: true })
    genMock.mockResolvedValue({ outcome: 'noop_at_capacity', count: 0, retryable: false })
    const body = await (await GET(cronReq())).json()
    expect(workerAdmin._reads()).toContain('intro_requests') // current-state check, not pair history
    expect(body.completed).toBe(1)
  })
  it('noop_at_capacity matched through a reciprocal pair → completed', async () => {
    workerAdmin = makeWorkerAdmin([job2('a')], { activeCard: false, matched: true })
    genMock.mockResolvedValue({ outcome: 'noop_at_capacity', count: 0, retryable: false })
    const body = await (await GET(cronReq())).json()
    expect(body.completed).toBe(1)
  })
  it('noop_at_capacity with NO active card and NO match → rescheduled (never false-complete)', async () => {
    workerAdmin = makeWorkerAdmin([job2('a')], { activeCard: false, matched: false })
    genMock.mockResolvedValue({ outcome: 'noop_at_capacity', count: 0, retryable: false })
    const body = await (await GET(cronReq())).json()
    expect(body.rescheduled_capacity).toBe(1); expect(body.completed).toBe(0)
  })

  it('a DB update failure is detected, counted, and privacy-safely logged (not counted as the transition)', async () => {
    workerAdmin = makeWorkerAdmin([job2('a')], { updateError: true })
    genMock.mockResolvedValue({ outcome: 'created', count: 1, retryable: false })
    const body = await (await GET(cronReq())).json()
    expect(body.update_failed).toBe(1)
    expect(body.completed).toBe(0) // aggregate counts reflect ONLY persisted transitions
  })

  it('a claim failure (pre-migration) is safe — no work, no throw, aggregate zeros', async () => {
    workerAdmin = makeWorkerAdmin([], { claimError: true })
    const body = await (await GET(cronReq())).json()
    expect(body.claimed).toBe(0); expect(genMock).not.toHaveBeenCalled()
  })

  it('response + logs carry ONLY aggregate counts — no user identifiers', async () => {
    const UID = 'd11d1c98-e016-497f-9308-e5a4f3caa146'
    workerAdmin = makeWorkerAdmin([job2(UID)])
    genMock.mockResolvedValue({ outcome: 'created', count: 1, retryable: false })
    const body = await (await GET(cronReq())).json()
    expect(JSON.stringify(body)).not.toContain(UID)            // no user_id in the response
    expect(Object.keys(body).sort()).toEqual(['claimed', 'completed', 'rescheduled_capacity', 'rescheduled_empty', 'rescheduled_transient', 'success', 'terminal_exhausted', 'terminal_ineligible', 'update_failed', 'worker_timed_out'])
  })
})
function job2(id: string) { return { user_id: id, status: 'pending', reason: 'capacity', attempt_count: 0, created_at: new Date(NOW).toISOString(), cycle_started_at: new Date(NOW).toISOString() } }

// ── Migration 051 — idempotent, hardened, service-role-only, zero policies ───────────
describe('migration 051 (structural)', () => {
  const sql = readFileSync('supabase/migrations/051_onboarding_recommendation_retries.sql', 'utf8')
  // Executable SQL only — strip `--` comment lines and COMMENT ON statements (which describe what is
  // NOT stored) so privacy/destructive assertions test the actual statements.
  const code = sql.replace(/COMMENT ON[\s\S]*?;/g, '').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
  it('is additive/idempotent + non-destructive', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.onboarding_recommendation_retries')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS')
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.enqueue_onboarding_retry/)
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.claim_onboarding_retries/)
    // No destructive STATEMENTS (ON DELETE CASCADE is a referential clause, not a delete).
    expect(code).not.toMatch(/DROP\s+(TABLE|FUNCTION|INDEX)|DELETE\s+FROM|TRUNCATE/i)
  })
  it('is service-role only with RLS + ZERO end-user policies', () => {
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain('REVOKE ALL ON public.onboarding_recommendation_retries FROM PUBLIC, anon, authenticated')
    expect(sql).not.toMatch(/CREATE POLICY/)
    for (const fn of ['enqueue_onboarding_retry', 'claim_onboarding_retries']) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(.*\\) FROM PUBLIC, anon, authenticated`))
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(.*\\) TO service_role`))
    }
  })
  it('the claim RPC is hardened + atomic (SECURITY DEFINER, empty search_path, FOR UPDATE SKIP LOCKED)', () => {
    expect(sql).toContain('SECURITY DEFINER')
    // An explicitly PINNED EMPTY search path. Accept BOTH the migration-source form `SET search_path = ''`
    // and PostgreSQL's stored proconfig / pg_get_functiondef representation `search_path=""` — either one
    // proves the path is pinned to the empty string (NOT merely absent, which would be unsafe).
    expect(sql).toMatch(/search_path\s*=\s*(''|"")/)          // explicit empty pin, either representation
    expect(sql).not.toMatch(/search_path\s*=\s*(?!''|"")\S/)  // never a NON-empty pinned path
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(sql).toContain('pg_catalog.now()')                         // catalog functions schema-qualified
    expect(sql).toContain('pg_catalog.make_interval')
    expect(sql).toContain('LIMIT LEAST(GREATEST(COALESCE(p_limit, 0), 0), 20)')   // clamp [0,20], NULL→0
    expect(sql).toContain('LEAST(GREATEST(COALESCE(p_lease_seconds, 1), 1), 3600)') // lease bounded [1,3600]
    expect(sql).toContain('CHECK (attempt_count >= 0')                // non-negative attempts
    // completed/terminal are NOT claimable (subquery only selects pending-due or expired-processing).
    expect(sql).not.toMatch(/c\.status IN \('pending','processing','completed'/)
  })
  it('tracks a resettable cycle clock (cycle_started_at) separate from the immutable created_at', () => {
    expect(sql).toContain('cycle_started_at  timestamptz NOT NULL DEFAULT now()')
    // Idempotent add for any earlier-draft table.
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS cycle_started_at timestamptz NOT NULL DEFAULT now\(\)/)
    // created_at is NEVER in the upsert's DO UPDATE SET list (audit-immutable).
    const doUpdate = sql.slice(sql.indexOf('ON CONFLICT (user_id) DO UPDATE SET'))
    expect(doUpdate).not.toMatch(/^\s*created_at\s*=/m)
    // cycle_started_at (like attempt_count/status/next_attempt_at) resets ONLY for completed/terminal.
    expect(sql).toContain("cycle_started_at = CASE WHEN public.onboarding_recommendation_retries.status IN ('completed','terminal')")
    expect(sql).toContain('THEN pg_catalog.now() ELSE public.onboarding_recommendation_retries.cycle_started_at END')
  })
  it('enforces the bidirectional lease invariant (processing ⇔ non-null lease) at the schema level', () => {
    expect(sql).toContain('CONSTRAINT onboarding_retries_lease_matches_status')
    expect(sql).toContain("(status = 'processing' AND lease_expires_at IS NOT NULL)")
    expect(sql).toContain("(status <> 'processing' AND lease_expires_at IS NULL)")
  })
  it('bounds + validates enqueue inputs (backoff clamped [0,604800]; null user + invalid reason rejected)', () => {
    expect(sql).toContain('v_backoff integer := LEAST(GREATEST(COALESCE(p_backoff_seconds, 0), 0), 604800)')
    expect(sql).toMatch(/IF p_user_id IS NULL THEN\s*\n\s*RAISE EXCEPTION/)
    expect(sql).toMatch(/p_reason IS NULL OR p_reason NOT IN \('capacity','empty_pool','no_compatible_candidate','transient_error'\)/)
    expect(sql).toMatch(/RAISE EXCEPTION 'enqueue_onboarding_retry: invalid reason'/)
    // The clamped backoff is what actually feeds make_interval (no raw p_backoff_seconds reaches it).
    expect(sql).toContain('pg_catalog.make_interval(secs => v_backoff)')
  })
  it('stores NO identity/scores/profile/email — coarse status + timing only', () => {
    // `profiles(id)` is a legit FK; `no_compatible_candidate` is a status enum. Identity/score/
    // payload columns must not appear in code.
    expect(code).not.toMatch(/email|full_name|\bscore\b|candidate_|payload|token/i)
  })
})
