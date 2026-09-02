import { finalizeMutualMatch } from '@/lib/introductions/finalizeMutualMatch'
import { createNotificationSafe } from '@/lib/notifications'
import { EXPIRY_AGE_DAYS } from '@/lib/introductions/expiry'
import { buildBidirectionalMatchFilter } from '@/lib/db/filters'

/**
 * Retry mutual matches that could not complete because a member was out of credits.
 *
 * WHY A SWEEP AND NOT AN EVENT. Credits arrive by four separate routes — the monthly refill RPC, a
 * Stripe pack grant, a referral award, and admin_adjust_credits — two of which run inside the
 * database. Instrumenting all four means four places to keep in step, and a miss is invisible. A
 * sweep over the affected state is one place, and it is self-correcting: whatever restored the
 * credit, the next run finds the pair.
 *
 * THE PAIR IS OTHERWISE TRAPPED. Both rows sit at 'approved', so expire_intro_pair returns
 * protected/mutual_pending and never closes it, and neither row occupies visible capacity, so no
 * counter flags it. Without this sweep nothing in the product would ever look at it again.
 */

/**
 * CONSENT STALENESS. Anchored to EXPIRY_AGE_DAYS rather than chosen freshly: 14 days is already the
 * system's definition of how long an introduction decision stays live. A card older than that would
 * have expired on its own, so honouring a 14-day-old yes is exactly as fresh as any card a member is
 * holding right now. Past it, the same reasoning says the decision is stale and must not be spent
 * silently.
 */
export const CONSENT_FRESH_DAYS = EXPIRY_AGE_DAYS

export interface CreditBlockedSweepResult {
  scanned: number
  completed: number
  stillBlocked: number
  staleNotified: number
  failed: number
  truncated: boolean
}

interface PairRow { pair_id: string; requester_id: string; target_user_id: string; updated_at: string }

export async function runCreditBlockedSweep(
  admin: any,
  opts: { budgetMs: number; maxPairs?: number },
): Promise<CreditBlockedSweepResult> {
  const started = Date.now()
  const maxPairs = opts.maxPairs ?? 50
  const out: CreditBlockedSweepResult = {
    scanned: 0, completed: 0, stillBlocked: 0, staleNotified: 0, failed: 0, truncated: false,
  }

  const { data: rows, error } = await admin
    .from('intro_requests')
    .select('pair_id, requester_id, target_user_id, updated_at')
    .not('pair_id', 'is', null)
    .in('status', ['approved', 'accepted', 'pending'])
  if (error) {
    console.error('[credit-blocked-sweep] read failed (class):', (error as any).code ?? 'unknown')
    return out
  }

  // A pair qualifies only when BOTH directions carry an interest row. One-sided interest is the
  // expiry worker's business, not this sweep's.
  const byPair = new Map<string, PairRow[]>()
  for (const r of (rows ?? []) as PairRow[]) {
    if (!r?.pair_id) continue
    const arr = byPair.get(r.pair_id) ?? []
    arr.push(r); byPair.set(r.pair_id, arr)
  }

  for (const [pairId, pairRows] of Array.from(byPair.entries())) {
    if (out.scanned >= maxPairs || Date.now() - started > opts.budgetMs) { out.truncated = true; break }
    const requesters = new Set(pairRows.map((r) => r.requester_id))
    if (requesters.size < 2) continue
    const [a, b] = Array.from(requesters)

    // Already connected → nothing to do. Checked per pair rather than pre-loaded: the set is small
    // and a stale read here would double-charge.
    const { data: existing } = await admin
      .from('matches').select('id').or(buildBidirectionalMatchFilter(a, b)).limit(1)
    if ((existing ?? []).length > 0) continue

    out.scanned++

    // Age from the LATER of the two decisions: the pair is only as old as its most recent yes.
    const latest = pairRows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), pairRows[0].updated_at)
    const ageDays = (Date.now() - new Date(latest).getTime()) / 86_400_000

    if (ageDays > CONSENT_FRESH_DAYS) {
      // DO NOT SPEND A STALE YES. Tell both sides once and leave the pair intact — a credit taken
      // for a decision someone made six weeks ago and may not remember is worse than a delay.
      const notified = await createNotificationSafe({
        userId: a,
        type: 'match_pending_credits',
        dedupeKey: `match_stale:${pairId}`,
        link: '/dashboard/introductions',
        data: { pairId, role: 'stale' },
      })
      await createNotificationSafe({
        userId: b,
        type: 'match_pending_credits',
        dedupeKey: `match_stale:${pairId}`,
        link: '/dashboard/introductions',
        data: { pairId, role: 'stale' },
      })
      if (notified) out.staleNotified++
      continue
    }

    // FRESH — complete it. finalizeMutualMatch destructures `supabase` but never uses it (verified
    // repo-wide: no `supabase.` reference in that file), so the service-role client is passed for
    // all three. Authority is unchanged: both members are already recorded as having said yes, and
    // this call re-checks credits, existing match and consent inside the same RPC a member's own
    // click would use.
    try {
      const res = await finalizeMutualMatch({
        supabase: admin, adminClient: admin, graphClient: admin,
        actingUserId: a, otherUserId: b, isAdminInitiated: false,
      } as any)
      if (res.status === 200) out.completed++
      else out.stillBlocked++
    } catch (e: any) {
      console.error('[credit-blocked-sweep] finalize threw (non-fatal):', e?.message ?? 'unknown')
      out.failed++
    }
  }

  return out
}
