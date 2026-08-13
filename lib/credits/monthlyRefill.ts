import { getEffectiveTier, getMonthlyCredits } from '@/lib/tier-override'
import type { createAdminClient } from '@/lib/supabase/admin'

type Admin = ReturnType<typeof createAdminClient>

/**
 * Monthly membership-credit replenishment — pure decision logic + fail-closed tier resolution + the
 * anniversary date math, plus thin IO wrappers over the hardened migration-053 RPCs. The worker route
 * exports only its handler; every reusable constant/helper lives here.
 *
 * Included/free credits REFILL to the tier allowance on the signup anniversary; purchased (premium)
 * credits are never touched. Dates are UTC. Fulfillment idempotency is durable in the DB (per-cycle
 * ledger), never inferred from the balance.
 */

export const REFILL_TIERS = ['free', 'professional', 'executive', 'founding'] as const
export type RefillTier = (typeof REFILL_TIERS)[number]

// Worker bounds (kept here so the route file exports ONLY its handler + maxDuration).
export const REFILL_WORKER_LIMIT = 50       // hard cap on members claimed per run (bounded batch)
export const REFILL_LEASE_SECONDS = 120     // >> the worker deadline, so a claimed member never reclaims mid-run
export const REFILL_WORKER_DEADLINE_MS = 25_000

export type RefillEvent =
  | 'refilled' | 'already_processed' | 'stale_claim' | 'not_due' | 'invalid_tier'
  | 'needs_review' | 'update_failed'

/**
 * JS mirror of the SQL public.effective_credit_tier — documents/tests that the DB tier resolution
 * matches the app's getEffectiveTier exactly (founding expiry + subscription fallback). `now` is
 * injectable for deterministic tests; defaults to the current time.
 */
export function effectiveCreditTier(
  p: { is_founding_member?: boolean | null; founding_member_expires_at?: string | null; subscription_tier?: string | null },
  now: Date = new Date(),
): string {
  if (p.is_founding_member) {
    if (p.founding_member_expires_at && new Date(p.founding_member_expires_at) < now) {
      return p.subscription_tier || 'free'
    }
    return 'founding'
  }
  return p.subscription_tier || 'free'
}

/** Included monthly allowance for a tier, FAIL CLOSED: an unknown/inconsistent tier returns null
 *  (the worker then skips rather than granting a default). Founding resolves to 15 via getMonthlyCredits. */
export function monthlyIncludedCredits(tier: string): number | null {
  if (!(REFILL_TIERS as readonly string[]).includes(tier)) return null
  return getMonthlyCredits(tier)
}

/**
 * First monthly anniversary of `anchorDay` STRICTLY AFTER the UTC date of `after` (YYYY-MM-DD). Day-31
 * anchors clamp to the month's last day (Feb→28/29, leap-safe). Pure — mirrors SQL next_credit_refill_on.
 */
export function nextCreditRefillOn(anchorDay: number, after: Date): string {
  const a = Math.max(1, Math.min(31, Math.trunc(anchorDay || 1)))
  const y = after.getUTCFullYear()
  const m = after.getUTCMonth() // 0-based
  const afterMidnight = Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate())
  for (let i = 0; i <= 3; i++) {
    const mm = m + i
    const year = y + Math.floor(mm / 12)
    const month = ((mm % 12) + 12) % 12
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    const day = Math.min(a, daysInMonth)
    const cand = Date.UTC(year, month, day)
    if (cand > afterMidnight) return new Date(cand).toISOString().slice(0, 10)
  }
  // Unreachable in practice; keep a deterministic fallback.
  return new Date(Date.UTC(y, m + 1, 1)).toISOString().slice(0, 10)
}

export interface ClaimedMember {
  user_id: string
  cycle_on: string           // the due cycle date (YYYY-MM-DD) = the stored next_refill_on
  lease_token: string        // ownership proof for this claim (rotated on every claim)
  claimed_tier: string | null // AUTHORITATIVE effective tier resolved + stored server-side at claim time
}

export type RefillDecision =
  | { action: 'refill' }
  | { action: 'skip'; reason: 'unknown_tier' }

/**
 * PURE worker decision for one claimed member. The effective tier was resolved AUTHORITATIVELY in the
 * DB at claim time (effective_credit_tier, a mirror of getEffectiveTier) and returned as claimed_tier;
 * the worker only decides refill-vs-park from it and NEVER supplies a tier/amount/date to apply (the DB
 * binds the tier and derives the allowance + next date). Fail closed on an unknown/absent claimed tier.
 */
export function decideRefill(member: ClaimedMember): RefillDecision {
  if (!member.claimed_tier || monthlyIncludedCredits(member.claimed_tier) == null) {
    return { action: 'skip', reason: 'unknown_tier' }
  }
  return { action: 'refill' }
}

// ── IO (thin wrappers over the hardened RPCs) ─────────────────────────────────────────────
export async function claimDueRefills(admin: Admin, limit: number, leaseSeconds: number): Promise<ClaimedMember[]> {
  const { data, error } = await admin.rpc('claim_due_credit_refills', { p_limit: limit, p_lease_seconds: leaseSeconds })
  if (error) throw new Error('claim_failed')
  return (data ?? []) as ClaimedMember[]
}

export type ApplyOutcome = 'refilled' | 'already_processed' | 'stale_claim' | 'not_due' | 'invalid_tier'

/**
 * Apply one refill via the atomic, TIER-BOUND, cycle-bound, lease-owned RPC. Takes NO tier — the DB
 * uses the stored claimed_tier (and rejects if the member's current effective tier has drifted).
 */
export async function applyRefill(
  admin: Admin,
  args: { userId: string; cycleOn: string; leaseToken: string },
): Promise<ApplyOutcome> {
  const { data, error } = await admin.rpc('apply_credit_refill', {
    p_user_id: args.userId, p_cycle_on: args.cycleOn, p_lease_token: args.leaseToken,
  })
  if (error) throw new Error('apply_failed')
  return (data as ApplyOutcome)
}

/** Park an unknown-tier cycle for operator review (grants nothing; removed from future claims). */
export async function parkCycle(
  admin: Admin,
  args: { userId: string; cycleOn: string; leaseToken: string },
): Promise<'parked' | 'stale_claim'> {
  const { data, error } = await admin.rpc('park_credit_cycle', {
    p_user_id: args.userId, p_cycle_on: args.cycleOn, p_lease_token: args.leaseToken,
  })
  if (error) throw new Error('park_failed')
  return (data as 'parked' | 'stale_claim')
}

/** Read-only admin status (no secrets/ids beyond what the caller already holds). */
export function describeMonthlyCredit(
  profile: { is_founding_member?: boolean | null; founding_member_expires_at?: string | null; subscription_tier?: string | null },
  cycle?: { next_refill_on?: string | null; last_refill_on?: string | null } | null,
): { effectiveTier: string; includedAllowance: number | null; nextRefillOn: string | null; lastRefillOn: string | null } {
  const effectiveTier = getEffectiveTier(profile)
  return {
    effectiveTier,
    includedAllowance: monthlyIncludedCredits(effectiveTier),
    nextRefillOn: cycle?.next_refill_on ?? null,
    lastRefillOn: cycle?.last_refill_on ?? null,
  }
}
