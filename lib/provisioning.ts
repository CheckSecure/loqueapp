/**
 * lib/provisioning.ts — member provisioning: idempotent, retryable, reconcilable.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Matt Boucher incident traced to a 2026-07-14 bulk founding invite where ~58% of
 * profile/credit inserts failed *transiently* (connection-pool/timeouts/rate-limits under
 * load) and were swallowed — `adminSendWaitlistInvite` fired the inserts without checking
 * their results, with no retry, no transaction, and no reconciliation. That left dozens of
 * orphaned Auth users (verified email + password identity, but no profile/credits/onboarding
 * state). A partial (not 100%) failure rate proved it was transient, not a schema/RLS defect.
 *
 * DESIGN
 * ------
 *  1. IDEMPOTENT — every step is check-then-insert, so running provisioning twice never
 *     duplicates a profile, credit balance, transaction, or founding status. Retries and
 *     the reconciler always converge on the same correct state.
 *  2. RETRYABLE — transient DB errors are retried with exponential backoff + jitter; only
 *     genuinely transient errors are retried (a constraint violation fails fast).
 *  3. NO SILENT FAILURE — every step's result is checked; an incomplete provision emits a
 *     structured, alertable error log and is returned to the caller.
 *  4. RECOVERABLE, NOT ROLLED BACK — a true cross-service transaction is impossible here
 *     (the Auth service and Postgres can't share one), and deleting the Auth user on failure
 *     is dangerous (it could destroy a real/partially-onboarded account). Because every step
 *     is idempotent, a partial provision is a *recoverable* state that a retry or the
 *     reconciler completes — never a dead end. `reconcileMissingProvisioning` is the standing
 *     admin capability that detects and completes any account that slips through.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getMonthlyCredits } from '@/lib/tier-override'
import { emitMetric } from '@/lib/metrics'

export interface ProvisionInput {
  userId: string
  email: string
  fullName: string | null
  markAsFounding: boolean
}

export interface ProvisionResult {
  ok: boolean
  created: string[]
  existed: string[]
  errors: { step: string; message: string }[]
}

// ---------------------------------------------------------------------------
// Structured, alertable logging. Emits single-line JSON so log drains / alerting
// (Vercel, Sentry, Datadog) can trigger on `level:"error"` + `event:"provision_incomplete"`.
// NEVER receives secrets — only ids, emails, and step names.
// ---------------------------------------------------------------------------
export function logProvisioningEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown>,
): void {
  const line = JSON.stringify({ scope: 'provisioning', level, event, ...fields })
  if (level === 'error') console.error('[provisioning]', line)
  else if (level === 'warn') console.warn('[provisioning]', line)
  else console.log('[provisioning]', line)
}

// Postgres/PostgREST transient error signatures worth retrying. Constraint violations
// (23xxx) are NOT here — they are permanent and must fail fast.
const TRANSIENT_PG_CODES = new Set(['57014', '53300', '53400', '08000', '08003', '08006', '40001', '40P01'])

export function isTransientError(error: any): boolean {
  const code = String(error?.code ?? '')
  if (TRANSIENT_PG_CODES.has(code)) return true
  const msg = String(error?.message ?? '').toLowerCase()
  return /timeout|timed out|connection|econnreset|econnrefused|fetch failed|network|rate ?limit|too many|temporarily|\b429\b|\b50[234]\b/.test(msg)
}

function asRetryError(error: any): Error & { transient?: boolean; code?: string } {
  const e: any = new Error(error?.message ?? 'database error')
  e.code = error?.code
  e.transient = isTransientError(error)
  return e
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Run `fn` with exponential backoff + jitter, retrying ONLY errors flagged `.transient`.
 * `baseMs` is small in tests so the suite stays fast.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { label: string; retries?: number; baseMs?: number },
): Promise<T> {
  const retries = opts.retries ?? 3
  const base = opts.baseMs ?? 200
  let lastErr: any
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (e: any) {
      lastErr = e
      if (attempt === retries || !e?.transient) break
      const delay = base * 2 ** attempt + Math.floor(Math.random() * base) // jitter
      emitMetric('provisioning_retry', { step: opts.label.split(':')[0], attempt: attempt + 1 })
      logProvisioningEvent('warn', 'provision_step_retry', { label: opts.label, attempt: attempt + 1, delayMs: delay, error: e?.message })
      await sleep(delay)
    }
  }
  throw lastErr
}

/**
 * Ensure a single row exists (check-then-insert), idempotently and with retry. A concurrent
 * insert that loses the race (unique violation, code 23505) is treated as success.
 */
async function ensureRecord(
  admin: SupabaseClient,
  opts: { table: string; existsFilter: Record<string, any>; row: Record<string, any>; label: string; baseMs?: number },
): Promise<'created' | 'exists'> {
  return withRetry(async () => {
    let q: any = (admin as any).from(opts.table).select('id')
    for (const [k, v] of Object.entries(opts.existsFilter)) q = q.eq(k, v)
    const found = await q.limit(1)
    if (found.error) throw asRetryError(found.error)
    if ((found.data?.length ?? 0) > 0) return 'exists'

    const ins = await (admin as any).from(opts.table).insert(opts.row)
    if (ins.error) {
      if (String(ins.error.code) === '23505') return 'exists' // lost a race — already there
      throw asRetryError(ins.error)
    }
    return 'created'
  }, { label: opts.label, baseMs: opts.baseMs })
}

/**
 * Idempotently provision the DB records a member needs after their Auth user exists:
 * profile, credit balance, and signup credit transaction. Safe to run any number of times.
 * Returns per-step outcomes; on any failure emits an alertable error and returns ok:false
 * WITHOUT throwing (the caller decides how to surface it).
 */
export async function provisionMemberRecords(
  admin: SupabaseClient,
  input: ProvisionInput,
  opts?: { baseMs?: number },
): Promise<ProvisionResult> {
  const { userId, email, fullName, markAsFounding } = input
  const tier = markAsFounding ? 'founding' : 'free'
  const floor = getMonthlyCredits(tier)
  const now = new Date().toISOString()
  const note = markAsFounding ? 'founding_signup_bonus' : 'signup_bonus'
  const baseMs = opts?.baseMs

  const steps: { name: string; run: () => Promise<'created' | 'exists'> }[] = [
    {
      name: 'profile',
      run: () => ensureRecord(admin, {
        table: 'profiles', existsFilter: { id: userId }, label: `profile:${userId}`, baseMs,
        row: {
          id: userId, email, full_name: fullName,
          password_reset_required: true, email_verified: true, email_verified_at: now,
          verification_status: 'pending', trust_score: 50,
          account_status: 'active', profile_complete: false,
          ...(markAsFounding ? { is_founding_member: true, founding_member_expires_at: null } : {}),
        },
      }),
    },
    {
      name: 'credits',
      run: () => ensureRecord(admin, {
        table: 'meeting_credits', existsFilter: { user_id: userId }, label: `credits:${userId}`, baseMs,
        row: { user_id: userId, free_credits: floor, premium_credits: 0, balance: floor, lifetime_earned: floor },
      }),
    },
    {
      name: 'credit_transaction',
      run: () => ensureRecord(admin, {
        table: 'credit_transactions', existsFilter: { user_id: userId, note }, label: `txn:${userId}`, baseMs,
        row: { user_id: userId, amount: floor, type: 'credit', note },
      }),
    },
  ]

  const created: string[] = []
  const existed: string[] = []
  const errors: { step: string; message: string }[] = []
  for (const s of steps) {
    try {
      const r = await s.run()
      ;(r === 'created' ? created : existed).push(s.name)
    } catch (e: any) {
      errors.push({ step: s.name, message: e?.message ?? 'unknown' })
    }
  }

  const ok = errors.length === 0
  logProvisioningEvent(ok ? 'info' : 'error', ok ? 'provision_complete' : 'provision_incomplete', {
    userId, email, created, existed, failedSteps: errors.map((e) => e.step),
  })
  emitMetric(ok ? 'provisioning_success' : 'provisioning_failure', {
    founding: markAsFounding, created: created.length, existed: existed.length, failed: errors.length,
  })
  return { ok, created, existed, errors }
}

// ---------------------------------------------------------------------------
// Reconciliation — a permanent admin capability (see the reconcile-provisioning route).
// ---------------------------------------------------------------------------

export interface AffectedAccount {
  userId: string
  email: string
  fullName: string | null
  markAsFounding: boolean
  waitlistStatus: string
  inviteDate: string | null
  hasProfile: boolean
  hasCredits: boolean
  recommendedAction: string
}

/**
 * Pure classifier (no IO) — given the raw lists, compute which WAITLIST-BACKED Auth users
 * are missing a profile or credit balance. Seed/test Auth users (not in the waitlist) are
 * intentionally excluded so reconciliation never fabricates records for fixtures.
 */
export function computeAffected(
  authUsers: { id: string; email?: string | null; created_at?: string; user_metadata?: any }[],
  profileIds: Set<string>,
  creditUserIds: Set<string>,
  waitlist: Map<string, { status: string; full_name: string | null }>,
): AffectedAccount[] {
  const out: AffectedAccount[] = []
  for (const u of authUsers) {
    const email = (u.email ?? '').toLowerCase()
    const w = waitlist.get(email)
    if (!w) continue // not a real invite — skip seed/test users
    const hasProfile = profileIds.has(u.id)
    const hasCredits = creditUserIds.has(u.id)
    if (hasProfile && hasCredits) continue
    const founding = !!u.user_metadata?.markAsFounding
    const floor = getMonthlyCredits(founding ? 'founding' : 'free')
    const recommendedAction = !hasProfile
      ? `Provision profile + ${floor} ${founding ? 'founding ' : ''}credits`
      : `Provision ${floor} ${founding ? 'founding ' : ''}credits only`
    out.push({
      userId: u.id, email: u.email ?? '', fullName: w.full_name,
      markAsFounding: founding, waitlistStatus: w.status,
      inviteDate: u.created_at ? u.created_at.slice(0, 10) : null,
      hasProfile, hasCredits, recommendedAction,
    })
  }
  return out.sort((a, b) => (a.inviteDate ?? '').localeCompare(b.inviteDate ?? '') || (a.fullName ?? '').localeCompare(b.fullName ?? ''))
}

async function pageAll<T>(fetchPage: (from: number, to: number) => Promise<{ data: T[] | null; error: any }>): Promise<T[]> {
  const all: T[] = []
  let from = 0
  const size = 1000
  for (;;) {
    const { data, error } = await fetchPage(from, from + size - 1)
    if (error) throw asRetryError(error)
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < size) break
    from += size
  }
  return all
}

/** Fetch live state and return the waitlist-backed accounts missing provisioning. */
export async function auditMissingProvisioning(admin: SupabaseClient): Promise<AffectedAccount[]> {
  const users: any[] = []
  let page = 1
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw asRetryError(error)
    users.push(...(data.users ?? []))
    if ((data.users ?? []).length < 1000) break
    page++
  }
  const profiles = await pageAll<{ id: string }>((f, t) => (admin as any).from('profiles').select('id').range(f, t))
  const credits = await pageAll<{ user_id: string }>((f, t) => (admin as any).from('meeting_credits').select('user_id').range(f, t))
  const wlRows = await pageAll<{ email: string | null; status: string; full_name: string | null }>((f, t) =>
    (admin as any).from('waitlist').select('email,status,full_name').range(f, t))

  const waitlist = new Map<string, { status: string; full_name: string | null }>()
  for (const w of wlRows) waitlist.set((w.email ?? '').toLowerCase(), { status: w.status, full_name: w.full_name })

  return computeAffected(users, new Set(profiles.map((p) => p.id)), new Set(credits.map((c) => c.user_id)), waitlist)
}

/**
 * Standing reconciler: audit, then (unless dryRun) idempotently provision every affected
 * account — optionally restricted to an explicit `emails` allowlist so an operator can
 * repair a reviewed subset. Idempotent: re-running converges and never duplicates records.
 */
export async function reconcileMissingProvisioning(
  admin: SupabaseClient,
  opts?: { dryRun?: boolean; emails?: string[] },
): Promise<{ audited: number; targeted: number; repaired: number; affected: AffectedAccount[]; results: { email: string; result: ProvisionResult }[] }> {
  const affected = await auditMissingProvisioning(admin)
  const allow = opts?.emails ? new Set(opts.emails.map((e) => e.toLowerCase())) : null
  const targets = allow ? affected.filter((a) => allow.has(a.email.toLowerCase())) : affected

  if (opts?.dryRun) {
    return { audited: affected.length, targeted: targets.length, repaired: 0, affected, results: [] }
  }

  const results: { email: string; result: ProvisionResult }[] = []
  for (const t of targets) {
    const result = await provisionMemberRecords(admin, {
      userId: t.userId, email: t.email, fullName: t.fullName, markAsFounding: t.markAsFounding,
    })
    results.push({ email: t.email, result })
  }
  const repaired = results.filter((r) => r.result.ok).length
  logProvisioningEvent(repaired === targets.length ? 'info' : 'warn', 'reconcile_complete', {
    audited: affected.length, targeted: targets.length, repaired,
  })
  emitMetric('provisioning_reconciled', { audited: affected.length, targeted: targets.length, repaired })
  return { audited: affected.length, targeted: targets.length, repaired, affected, results }
}
