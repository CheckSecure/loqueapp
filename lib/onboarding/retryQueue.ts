/**
 * Durable, narrowly-scoped retry queue for onboarding reciprocal recommendations.
 *
 * When an onboarding generation attempt ends with a RETRYABLE outcome (the compatible pool was
 * momentarily unavailable), ONLY that specific member is enqueued for a bounded later retry. There
 * is NO global profile scan and NO broad backfill. The table stores only coarse status + timing —
 * never candidate identity, scores, profile data, email, names, or error payloads.
 *
 * Split: PURE decision logic (isRetryableOutcome / outcomeToReason / backoffSeconds /
 * decideRetryOutcome) is unit-tested; the IO helpers delegate atomic claim/enqueue to the hardened
 * SECURITY DEFINER RPCs (migration 051) and are fail-open so the app never breaks pre-migration.
 */
import type { GenerationOutcome } from '@/lib/generate-recommendations'
import type { createAdminClient } from '@/lib/supabase/admin'

type Admin = ReturnType<typeof createAdminClient>

export type RetryReason = 'capacity' | 'empty_pool' | 'no_compatible_candidate' | 'transient_error'
export type RetryStatus = 'pending' | 'processing' | 'completed' | 'terminal'
export type WorkerEvent =
  | 'completed' | 'rescheduled_capacity' | 'rescheduled_empty' | 'rescheduled_transient'
  | 'terminal_ineligible' | 'terminal_exhausted'

/** Outcomes that warrant a durable retry (a later attempt may succeed). */
export const RETRYABLE_OUTCOMES: GenerationOutcome[] = ['capacity', 'empty_pool', 'no_compatible_candidate', 'transient_error']
export function isRetryableOutcome(o: GenerationOutcome): boolean { return (RETRYABLE_OUTCOMES as string[]).includes(o) }

/** Map a generation outcome to a queue reason (null when the outcome is not retryable). */
export function outcomeToReason(o: GenerationOutcome): RetryReason | null {
  switch (o) {
    case 'capacity': return 'capacity'
    case 'empty_pool': return 'empty_pool'
    case 'no_compatible_candidate': return 'no_compatible_candidate'
    case 'transient_error': return 'transient_error'
    default: return null // created / noop_at_capacity / ineligible → NOT retryable
  }
}

// Bounded exponential backoff (deterministic — no Math.random, so it is unit-testable). Transient
// errors retry sooner; capacity/empty/no-compatible back off longer. A small deterministic spread
// avoids a thundering herd without randomness.
export const BACKOFF = {
  transient: { baseSec: 5 * 60, capSec: 6 * 60 * 60 },   // 5m → 6h
  slow:      { baseSec: 30 * 60, capSec: 24 * 60 * 60 },  // 30m → 24h
} as const
export const MAX_ATTEMPTS = 8
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000 // 14 days → manual review

// Worker limits (kept here so the route file exports ONLY its handler; Next.js forbids other exports).
export const WORKER_LIMIT = 4            // hard cap on jobs claimed per run (3–5)
export const LEASE_SECONDS = 120         // >> the worker deadline, so a claimed job never reclaims mid-run
export const WORKER_DEADLINE_MS = 25_000 // ample margin before the platform timeout

export function backoffSeconds(reason: RetryReason, attemptCount: number): number {
  const cfg = reason === 'transient_error' ? BACKOFF.transient : BACKOFF.slow
  const n = Math.max(0, attemptCount)
  const exp = Math.min(cfg.capSec, cfg.baseSec * Math.pow(2, n))
  const spread = Math.round(exp * 0.1 * ((n % 3) / 3)) // deterministic ±≤10% spread
  return Math.min(cfg.capSec + Math.round(cfg.capSec * 0.1), exp + spread)
}

export interface JobRow {
  user_id: string
  status: RetryStatus
  reason: RetryReason
  attempt_count: number
  created_at: string
  cycle_started_at: string // start of the CURRENT retry cycle — drives MAX_AGE, not created_at
}
export interface JobPatch {
  status: RetryStatus
  reason?: RetryReason
  attempt_count?: number
  next_attempt_at?: string
  last_attempt_at: string
  last_outcome: string
  lease_expires_at: null
}
export interface JobDecision { event: WorkerEvent; patch: JobPatch }

/**
 * PURE worker decision: given the claimed job, the generator outcome, and whether the member now
 * actually holds a reciprocal card, decide the next durable state. Never falsely completes a
 * capacity-blocked member; enforces the attempts/age ceiling → terminal (manual review).
 */
export function decideRetryOutcome(
  job: { attempt_count: number; cycle_started_at: string },
  outcome: GenerationOutcome,
  ctx: { now: number; hasActiveReciprocalOpportunity: boolean },
): JobDecision {
  const base = { last_attempt_at: new Date(ctx.now).toISOString(), last_outcome: outcome, lease_expires_at: null as null }

  if (outcome === 'created') return { event: 'completed', patch: { status: 'completed', ...base } }
  if (outcome === 'ineligible') return { event: 'terminal_ineligible', patch: { status: 'terminal', ...base } }
  // noop_at_capacity: complete ONLY when the member has a CURRENT active reciprocal opportunity
  // (own live row or a matched pair) — never on mere pair history. Otherwise (blocked by unrelated /
  // legacy card capacity, or a partial/inconsistent state) reschedule as capacity — never a false
  // completion.
  if (outcome === 'noop_at_capacity' && ctx.hasActiveReciprocalOpportunity) return { event: 'completed', patch: { status: 'completed', ...base } }

  // Everything else reschedules or exhausts. MAX_AGE is measured from the CURRENT cycle start.
  const reason: RetryReason = outcome === 'noop_at_capacity' ? 'capacity' : (outcomeToReason(outcome) as RetryReason)
  const nextAttempt = job.attempt_count + 1
  const ageMs = ctx.now - (Date.parse(job.cycle_started_at) || ctx.now)
  if (nextAttempt >= MAX_ATTEMPTS || ageMs >= MAX_AGE_MS) {
    return { event: 'terminal_exhausted', patch: { status: 'terminal', reason, attempt_count: nextAttempt, ...base } }
  }
  const next = new Date(ctx.now + backoffSeconds(reason, nextAttempt) * 1000).toISOString()
  const event: WorkerEvent =
    reason === 'capacity' ? 'rescheduled_capacity'
      : reason === 'transient_error' ? 'rescheduled_transient'
        : 'rescheduled_empty' // empty_pool + no_compatible_candidate
  return { event, patch: { status: 'pending', reason, attempt_count: nextAttempt, next_attempt_at: next, ...base } }
}

// ── IO (fail-open; delegate atomicity to the RPCs) ────────────────────────────────────
/**
 * Enqueue THIS ONE member on a retryable outcome (no-op otherwise). Delegates to the upsert RPC so
 * a job is never duplicated and a completed/terminal job is resurrected ONLY on this new explicit
 * failure. Fail-OPEN so onboarding never breaks, but a write failure is DISTINGUISHABLE: it returns
 * false and emits a privacy-safe `queue_enqueue_failed` log (no user id, no raw DB error). Returns
 * TRUE only when durable retry was actually persisted — callers must not claim durable retry on false.
 */
export async function enqueueOnboardingRetry(admin: Admin, userId: string, outcome: GenerationOutcome): Promise<boolean> {
  const reason = outcomeToReason(outcome)
  if (!reason) return false // created/noop/ineligible → nothing to enqueue
  const fail = (errClass: string) => {
    console.warn('[onboarding-retry]', JSON.stringify({ event: 'queue_enqueue_failed', reason, error_class: errClass }))
    return false
  }
  try {
    const { error } = await admin.rpc('enqueue_onboarding_retry', {
      p_user_id: userId, p_reason: reason, p_backoff_seconds: backoffSeconds(reason, 0),
    })
    if (error) return fail(error.code ?? 'unknown')
    return true
  } catch (err: any) {
    return fail(err?.name ?? 'error')
  }
}

/** Atomically claim up to `limit` due jobs (+ reclaim expired leases) via the hardened RPC. */
export async function claimOnboardingRetries(admin: Admin, limit: number, leaseSeconds: number): Promise<JobRow[]> {
  const { data, error } = await admin.rpc('claim_onboarding_retries', { p_limit: limit, p_lease_seconds: leaseSeconds })
  if (error) throw new Error('claim_failed')
  return (data ?? []) as JobRow[]
}

/**
 * Persist the worker's decision for a claimed job (it owns the lease → a direct scoped update is
 * safe). Returns whether the row was actually written, so the worker's aggregate counts can reflect
 * ONLY persisted transitions and a write failure is detectable.
 */
export async function applyJobDecision(admin: Admin, userId: string, decision: JobDecision): Promise<boolean> {
  const { error } = await admin.from('onboarding_recommendation_retries')
    .update({ ...decision.patch, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
  return !error
}
