import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  claimDueRefills, applyRefill, parkCycle, decideRefill,
  REFILL_WORKER_LIMIT, REFILL_LEASE_SECONDS, REFILL_WORKER_DEADLINE_MS, type RefillEvent,
} from '@/lib/credits/monthlyRefill'

/**
 * Daily bounded monthly-credit refill worker.
 *
 * Processes ONLY members whose signup-anniversary cycle is DUE (claimed atomically with a lease via
 * migration-053 claim_due_credit_refills). NO unbounded profile scan and NO N+1: one claim returns a
 * hard-capped batch (with the tier fields joined in), then each member is refilled SEQUENTIALLY via the
 * atomic apply_credit_refill RPC (durable per-cycle idempotency in credit_refills). It replaces
 * included/free credits to the tier allowance, PRESERVES purchased (premium) credits exactly, stops
 * cleanly at a time budget, and returns aggregate counts only — no member identities. It is safe on
 * Vercel Hobby's once-daily cron: a member is refilled at most once per anniversary regardless of how
 * often this runs, and an overdue member is caught up in ONE refill (the schedule jumps to the next
 * future anniversary — never multiple historical grants).
 */
export const maxDuration = 30

export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const deadlineAt = Date.now() + REFILL_WORKER_DEADLINE_MS
  const tally: Record<RefillEvent | 'claimed' | 'worker_timed_out', number> = {
    claimed: 0, refilled: 0, already_processed: 0, stale_claim: 0, not_due: 0, invalid_tier: 0,
    needs_review: 0, update_failed: 0, worker_timed_out: 0,
  }

  let members
  try {
    members = await claimDueRefills(admin, REFILL_WORKER_LIMIT, REFILL_LEASE_SECONDS)
  } catch {
    // Table/RPC absent (pre-migration) or a transient claim error → nothing to do this run.
    return NextResponse.json({ success: true, ...tally })
  }
  tally.claimed = members.length

  // SEQUENTIAL — one member at a time (protects the DB); stop cleanly at the time budget. A claimed but
  // unstarted member keeps its lease and is reclaimed after it expires (no missed/duplicate refill: the
  // per-cycle ledger is the authority). Every started member's apply is atomic + idempotent.
  for (const member of members) {
    if (Date.now() >= deadlineAt) { tally.worker_timed_out++; break }

    const decision = decideRefill(member)
    if (decision.action === 'skip') {
      // Fail closed on an unknown/inconsistent tier: PARK it (needs_review) so it grants nothing AND is
      // removed from future claims — no infinite hot loop, and visible to operators.
      try {
        const parked = await parkCycle(admin, { userId: member.user_id, cycleOn: member.cycle_on, leaseToken: member.lease_token })
        if (parked === 'parked') tally.needs_review++
        else tally.stale_claim++
      } catch { tally.update_failed++ }
      console.warn('[daily-refill]', JSON.stringify({ event: 'needs_review' }))
      continue
    }

    try {
      // The DB binds the tier (stored claimed_tier), the cycle, and the lease token, and derives the
      // amount + next date itself — the worker supplies no tier/amount/date.
      const outcome = await applyRefill(admin, {
        userId: member.user_id, cycleOn: member.cycle_on, leaseToken: member.lease_token,
      })
      tally[outcome]++ // refilled | already_processed | stale_claim | not_due | invalid_tier
    } catch {
      // DB/RPC failure → nothing committed (atomic). Row stays leased; its lease expiry reclaims it.
      tally.update_failed++
      console.warn('[daily-refill]', JSON.stringify({ event: 'update_failed' }))
    }
  }

  console.log('[daily-refill]', JSON.stringify(tally))
  return NextResponse.json({ success: true, ...tally })
}
