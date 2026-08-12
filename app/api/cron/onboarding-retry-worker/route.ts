import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateReciprocalBatchForMember } from '@/lib/generate-recommendations'
import {
  claimOnboardingRetries, applyJobDecision, decideRetryOutcome,
  WORKER_LIMIT, LEASE_SECONDS, WORKER_DEADLINE_MS, type WorkerEvent,
} from '@/lib/onboarding/retryQueue'
import { hasActiveReciprocalOpportunity } from '@/lib/introductions/activeReciprocalOpportunity'

/**
 * Durable onboarding-retry worker.
 *
 * Processes ONLY members already enqueued in onboarding_recommendation_retries. It NEVER scans
 * profiles and NEVER accepts user IDs from a request body. Each run atomically CLAIMS a very small,
 * hard-capped batch (with a lease so concurrent workers cannot touch the same member), then re-runs
 * the SAME bounded generator per member SEQUENTIALLY, and durably records the privacy-safe outcome.
 * It stops cleanly before an overall time budget and returns aggregate counts only — no identities.
 * It creates no notifications/email; pair creation stays atomic/idempotent via the migration-050 RPC.
 */
export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const deadlineAt = Date.now() + WORKER_DEADLINE_MS
  const tally: Record<WorkerEvent | 'claimed' | 'worker_timed_out' | 'update_failed', number> = {
    claimed: 0, completed: 0, rescheduled_capacity: 0, rescheduled_empty: 0, rescheduled_transient: 0,
    terminal_ineligible: 0, terminal_exhausted: 0, worker_timed_out: 0, update_failed: 0,
  }

  let jobs
  try {
    jobs = await claimOnboardingRetries(admin, WORKER_LIMIT, LEASE_SECONDS)
  } catch {
    // Queue table/RPC absent (pre-migration) or a transient claim error → nothing to do this run.
    return NextResponse.json({ success: true, ...tally })
  }
  tally.claimed = jobs.length

  // SEQUENTIAL — one member at a time (protects Supabase); stop cleanly at the time budget. Any job
  // claimed but not started stays 'processing' with its bounded lease and is safely reclaimed after
  // it expires. Every job the worker DOES start leaves 'processing' (completed/terminal/rescheduled),
  // even on an ordinary generator exception (→ transient reschedule). attempt_count is incremented
  // ONLY on a successfully-persisted reschedule, so a crash/lease-expiry never consumes an attempt;
  // the MAX_AGE ceiling (from the original created_at) bounds total lifetime regardless.
  for (const job of jobs) {
    if (Date.now() >= deadlineAt) { tally.worker_timed_out++; break }

    let outcome: any
    let activeOpportunity = false
    try {
      const res = await generateReciprocalBatchForMember(job.user_id, 'onboarding_retry')
      outcome = res.outcome
      // noop_at_capacity is ambiguous — only 'completed' if a CURRENT active reciprocal opportunity
      // (own live row or matched pair) actually exists, not mere pair history. Otherwise reschedule.
      if (outcome === 'noop_at_capacity') activeOpportunity = await hasActiveReciprocalOpportunity(admin, job.user_id)
    } catch {
      outcome = 'transient_error' // handled exception → reschedule, never left leased with no decision
    }

    const decision = decideRetryOutcome(job, outcome, { now: Date.now(), hasActiveReciprocalOpportunity: activeOpportunity })
    let persisted = false
    try { persisted = await applyJobDecision(admin, job.user_id, decision) } catch { persisted = false }
    if (persisted) {
      tally[decision.event]++ // aggregate counts reflect ONLY persisted transitions
    } else {
      tally.update_failed++
      console.warn('[onboarding-retry-worker]', JSON.stringify({ event: 'queue_update_failed', decided: decision.event }))
      // Row stays 'processing'; its lease expiry safely reclaims it (no attempt consumed).
    }
  }

  console.log('[onboarding-retry-worker]', JSON.stringify(tally))
  return NextResponse.json({ success: true, ...tally })
}
