import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  provisionMemberRecords, computeAffected, reconcileMissingProvisioning,
  isTransientError, withRetry, logProvisioningEvent,
} from '@/lib/provisioning'

// ---------------------------------------------------------------------------
// Stateful in-memory mock of the Supabase service client: supports the query
// chains provisioning uses — from(t).select('id').eq(k,v).limit(n),
// from(t).select(...).range(a,b), from(t).insert(row) — plus auth.admin.listUsers.
// `insertFailures[table]` is a FIFO queue of errors injected on successive inserts,
// letting us simulate transient (retryable) and permanent (fail-fast) failures.
// ---------------------------------------------------------------------------
function makeDb(initial: { profiles?: any[]; meeting_credits?: any[]; credit_transactions?: any[]; waitlist?: any[]; users?: any[] } = {}, cfg: { insertFailures?: Record<string, any[]> } = {}) {
  const tables: Record<string, any[]> = {
    profiles: [...(initial.profiles ?? [])],
    meeting_credits: [...(initial.meeting_credits ?? [])],
    credit_transactions: [...(initial.credit_transactions ?? [])],
    waitlist: [...(initial.waitlist ?? [])],
  }
  const users = [...(initial.users ?? [])]
  const insertCounts: Record<string, number> = {}
  let idc = 1

  function builder(table: string) {
    const filters: Record<string, any> = {}
    const b: any = {
      select() { return b },
      eq(k: string, v: any) { filters[k] = v; return b },
      limit(n: number) {
        const rows = tables[table].filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v))
        return Promise.resolve({ data: rows.slice(0, n), error: null })
      },
      range(a: number, z: number) {
        return Promise.resolve({ data: tables[table].slice(a, z + 1), error: null })
      },
      insert(row: any) {
        insertCounts[table] = (insertCounts[table] ?? 0) + 1
        const q = cfg.insertFailures?.[table]
        if (q && q.length) { return Promise.resolve({ error: q.shift() }) }
        tables[table].push({ id: `${table}-${idc++}`, ...row })
        return Promise.resolve({ error: null })
      },
    }
    return b
  }

  return {
    _tables: tables,
    _insertCounts: insertCounts,
    from: (t: string) => builder(t),
    auth: {
      admin: {
        listUsers: ({ page }: { page: number }) =>
          Promise.resolve({ data: { users: page === 1 ? users : [] }, error: null }),
      },
    },
  } as any
}

const FAST = { baseMs: 1 }

let logSpy: any, errSpy: any, warnSpy: any
beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('provisionMemberRecords — happy path', () => {
  it('creates profile, credits, and a founding transaction exactly once', async () => {
    const db = makeDb({ waitlist: [{ email: 'a@x.com', status: 'invited', full_name: 'A' }] })
    const r = await provisionMemberRecords(db, { userId: 'u1', email: 'a@x.com', fullName: 'A', markAsFounding: true }, FAST)
    expect(r.ok).toBe(true)
    expect(r.created.sort()).toEqual(['credit_transaction', 'credits', 'profile'])
    expect(db._tables.profiles).toHaveLength(1)
    expect(db._tables.profiles[0]).toMatchObject({ id: 'u1', password_reset_required: true, email_verified: true, is_founding_member: true, account_status: 'active' })
    expect(db._tables.meeting_credits[0]).toMatchObject({ user_id: 'u1', balance: 30 })
    expect(db._tables.credit_transactions[0]).toMatchObject({ user_id: 'u1', amount: 30, note: 'founding_signup_bonus' })
  })

  it('non-founding member gets 3 credits + signup_bonus note', async () => {
    const db = makeDb()
    await provisionMemberRecords(db, { userId: 'u2', email: 'b@x.com', fullName: 'B', markAsFounding: false }, FAST)
    expect(db._tables.meeting_credits[0]).toMatchObject({ balance: 3 })
    expect(db._tables.credit_transactions[0]).toMatchObject({ note: 'signup_bonus' })
    expect(db._tables.profiles[0].is_founding_member).toBeUndefined()
  })
})

describe('provisionMemberRecords — idempotency', () => {
  it('running twice never duplicates profile, credits, or transaction', async () => {
    const db = makeDb()
    await provisionMemberRecords(db, { userId: 'u1', email: 'a@x.com', fullName: 'A', markAsFounding: true }, FAST)
    const second = await provisionMemberRecords(db, { userId: 'u1', email: 'a@x.com', fullName: 'A', markAsFounding: true }, FAST)
    expect(second.ok).toBe(true)
    expect(second.created).toEqual([])
    expect(second.existed.sort()).toEqual(['credit_transaction', 'credits', 'profile'])
    expect(db._tables.profiles).toHaveLength(1)
    expect(db._tables.meeting_credits).toHaveLength(1)
    expect(db._tables.credit_transactions).toHaveLength(1)
  })

  it('does not clobber an existing profile', async () => {
    const db = makeDb({ profiles: [{ id: 'u1', email: 'a@x.com', balance: 999, custom: 'keep' }] })
    await provisionMemberRecords(db, { userId: 'u1', email: 'a@x.com', fullName: 'A', markAsFounding: true }, FAST)
    expect(db._tables.profiles).toHaveLength(1)
    expect(db._tables.profiles[0].custom).toBe('keep')
    expect(db._insertCounts.profiles ?? 0).toBe(0)
  })
})

describe('provisionMemberRecords — failure handling', () => {
  it('reports a profile insert failure without silently succeeding', async () => {
    const db = makeDb({}, { insertFailures: { profiles: [{ code: '23502', message: 'null value' }] } })
    const r = await provisionMemberRecords(db, { userId: 'u1', email: 'a@x.com', fullName: 'A', markAsFounding: true }, FAST)
    expect(r.ok).toBe(false)
    expect(r.errors.map(e => e.step)).toContain('profile')
    // credits/transaction still attempted independently (no half-abort)
    expect(db._tables.meeting_credits).toHaveLength(1)
    // structured alert emitted
    expect(errSpy).toHaveBeenCalled()
    expect(errSpy.mock.calls.some((c: any[]) => String(c[1]).includes('provision_incomplete'))).toBe(true)
  })

  it('reports a credit insert failure', async () => {
    const db = makeDb({}, { insertFailures: { meeting_credits: [{ code: '23503', message: 'fk violation' }] } })
    const r = await provisionMemberRecords(db, { userId: 'u1', email: 'a@x.com', fullName: 'A', markAsFounding: false }, FAST)
    expect(r.ok).toBe(false)
    expect(r.errors.map(e => e.step)).toEqual(['credits'])
    expect(db._tables.profiles).toHaveLength(1)
  })

  it('retries a TRANSIENT failure with backoff and eventually succeeds', async () => {
    // two transient failures, then success
    const db = makeDb({}, { insertFailures: { profiles: [
      { code: '57014', message: 'statement timeout' },
      { message: 'fetch failed' },
    ] } })
    const r = await provisionMemberRecords(db, { userId: 'u1', email: 'a@x.com', fullName: 'A', markAsFounding: true }, FAST)
    expect(r.ok).toBe(true)
    expect(r.created).toContain('profile')
    expect(db._insertCounts.profiles).toBe(3) // 2 failed + 1 success
    expect(warnSpy.mock.calls.some((c: any[]) => String(c[1]).includes('provision_step_retry'))).toBe(true)
  })

  it('does NOT retry a permanent (constraint) failure', async () => {
    const db = makeDb({}, { insertFailures: { profiles: [
      { code: '23505', message: 'duplicate key' }, // 23505 is treated as "exists" (idempotent), so use a real permanent one:
    ] } })
    // 23505 → treated as exists → success with 0 net rows; verify no retry storm
    const r = await provisionMemberRecords(db, { userId: 'u1', email: 'a@x.com', fullName: 'A', markAsFounding: true }, FAST)
    expect(r.ok).toBe(true)
    expect(db._insertCounts.profiles).toBe(1)
  })

  it('a NOT NULL violation fails fast (single attempt, no retry)', async () => {
    const db = makeDb({}, { insertFailures: { credit_transactions: [
      { code: '23502', message: 'null value in column' },
    ] } })
    const r = await provisionMemberRecords(db, { userId: 'u1', email: 'a@x.com', fullName: 'A', markAsFounding: false }, FAST)
    expect(r.ok).toBe(false)
    expect(db._insertCounts.credit_transactions).toBe(1) // no retries on permanent error
  })
})

describe('isTransientError classification', () => {
  it('classifies timeouts / connection / rate-limit as transient', () => {
    expect(isTransientError({ code: '57014' })).toBe(true)
    expect(isTransientError({ code: '53300' })).toBe(true)
    expect(isTransientError({ message: 'fetch failed' })).toBe(true)
    expect(isTransientError({ message: 'Rate limit exceeded' })).toBe(true)
    expect(isTransientError({ message: 'Service returned 503' })).toBe(true)
  })
  it('classifies constraint violations as NOT transient', () => {
    expect(isTransientError({ code: '23505' })).toBe(false)
    expect(isTransientError({ code: '23502' })).toBe(false)
    expect(isTransientError({ code: '23503' })).toBe(false)
    expect(isTransientError({ message: 'invalid input syntax' })).toBe(false)
  })
})

describe('computeAffected — audit reconciliation', () => {
  const wl = new Map([
    ['real@x.com', { status: 'invited', full_name: 'Real' }],
    ['half@x.com', { status: 'invited', full_name: 'Half' }],
    ['done@x.com', { status: 'invited', full_name: 'Done' }],
  ])
  const users = [
    { id: 'real', email: 'real@x.com', created_at: '2026-07-14T00:00:00Z', user_metadata: { markAsFounding: true } }, // missing both
    { id: 'half', email: 'half@x.com', created_at: '2026-07-14T00:00:00Z', user_metadata: {} },                        // has profile, no credits
    { id: 'done', email: 'done@x.com', created_at: '2026-07-14T00:00:00Z', user_metadata: {} },                        // fully provisioned
    { id: 'seed', email: 'seed@fake.com', created_at: '2026-03-01T00:00:00Z', user_metadata: {} },                    // NOT in waitlist
  ]
  it('returns only waitlist-backed accounts missing records; excludes seed + complete', () => {
    const affected = computeAffected(users, new Set(['half', 'done']), new Set(['done']), wl)
    const emails = affected.map(a => a.email).sort()
    expect(emails).toEqual(['half@x.com', 'real@x.com'])
    expect(affected.find(a => a.email === 'real@x.com')!.recommendedAction).toMatch(/profile \+ 30 founding/)
    expect(affected.find(a => a.email === 'half@x.com')!.recommendedAction).toMatch(/3 credits only/)
    // seed@fake.com (not in waitlist) is never included
    expect(emails).not.toContain('seed@fake.com')
  })
})

describe('reconcileMissingProvisioning — standing repair', () => {
  const base = () => makeDb({
    users: [
      { id: 'u1', email: 'a@x.com', created_at: '2026-07-14T00:00:00Z', user_metadata: { markAsFounding: true } },
      { id: 'u2', email: 'b@x.com', created_at: '2026-07-14T00:00:00Z', user_metadata: {} },
      { id: 'seed', email: 's@fake.com', created_at: '2026-03-01T00:00:00Z', user_metadata: {} },
    ],
    waitlist: [
      { email: 'a@x.com', status: 'invited', full_name: 'A' },
      { email: 'b@x.com', status: 'invited', full_name: 'B' },
    ],
  })

  it('dryRun reports affected accounts and repairs nothing', async () => {
    const db = base()
    const out = await reconcileMissingProvisioning(db, { dryRun: true })
    expect(out.audited).toBe(2)
    expect(out.repaired).toBe(0)
    expect(db._tables.profiles).toHaveLength(0)
  })

  it('repairs all affected accounts, excludes seed, and is idempotent on re-run', async () => {
    const db = base()
    const first = await reconcileMissingProvisioning(db, {})
    expect(first.repaired).toBe(2)
    expect(db._tables.profiles).toHaveLength(2)
    expect(db._tables.meeting_credits).toHaveLength(2)
    expect(db._tables.profiles.find((p: any) => p.id === 'u1')!.is_founding_member).toBe(true)
    // seed account never provisioned
    expect(db._tables.profiles.find((p: any) => p.id === 'seed')).toBeUndefined()
    // re-run → converges, no duplicates
    const second = await reconcileMissingProvisioning(db, {})
    expect(second.audited).toBe(0)
    expect(db._tables.profiles).toHaveLength(2)
  })

  it('respects an explicit emails allowlist (reviewed subset only)', async () => {
    const db = base()
    const out = await reconcileMissingProvisioning(db, { emails: ['a@x.com'] })
    expect(out.targeted).toBe(1)
    expect(out.repaired).toBe(1)
    expect(db._tables.profiles.map((p: any) => p.id)).toEqual(['u1'])
  })
})

describe('no secrets in logs', () => {
  it('provisioning log lines never contain a password/token/secret field', async () => {
    const db = makeDb({}, { insertFailures: { profiles: [{ message: 'fetch failed' }] } })
    await provisionMemberRecords(db, { userId: 'u1', email: 'a@x.com', fullName: 'A', markAsFounding: true }, FAST)
    const allLines = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errSpy.mock.calls].map(c => c.join(' ')).join('\n').toLowerCase()
    expect(allLines).not.toMatch(/password|token|secret|service_role|bearer/)
  })
})
