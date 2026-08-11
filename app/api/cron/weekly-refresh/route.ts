import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateReciprocalBatchForMember } from '@/lib/generate-recommendations'
import { expireStaleReciprocalPairs } from '@/lib/matching/createReciprocalSuggestion'
import { evaluateWeeklyEligibility } from '@/lib/introductions/queue'
import { notifyPendingIntrosActionNeeded, isoWeekKey } from '@/lib/notifications/engagement'

/**
 * Weekly cron for the unified queue.
 *
 * CANONICAL WORKFLOW: the admin-reviewed reciprocal batch (System B: Generate → review →
 * Send/approve-batch) is the single Thursday generation + send path. To avoid TWO
 * independently-generated weekly batches, competing queues, and divergent algorithms,
 * automatic organic GENERATION here is DISABLED by default and gated behind the env flag
 * `WEEKLY_REFRESH_GENERATION` (set to '1' to re-enable — e.g. if the admin batch is ever
 * retired). Generation is never deleted, only gated.
 *
 * What this cron STILL does (safety net, cheap and idempotent): send the weekly
 * "action needed" reminder to members who have unresolved introductions — including any
 * unresolved member the admin batch did not pair — via the SAME shared helper and the
 * SAME ISO-week dedupe key (actionneeded:<ISO_WEEK>) as approve-batch. So whichever route
 * runs first handles the cycle and the other is a no-op: a member gets at most ONE
 * reminder per cycle across BOTH System A and System B. Promotion is unchanged
 * (promoteIfResolved reveals a queued batch when the member resolves their active one).
 */
const WEEKLY_REFRESH_GENERATION = process.env.WEEKLY_REFRESH_GENERATION === '1'

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const adminClient = createAdminClient()
  console.log('[Weekly Generation] Starting weekly recommendation generation...')

  const { data: users } = await adminClient
    .from('profiles')
    .select('id, email')
    .eq('account_status', 'active')
    .eq('profile_complete', true)
    .not('is_test_account', 'is', true)

  if (!users) return NextResponse.json({ error: 'No users found' }, { status: 500 })

  // ROTATION FIRST: expire untouched, stale reciprocal pairs (both directions atomically) BEFORE
  // generation, so freed capacity is available this run and two idle cards can never block a member
  // forever. Pairs with member activity are protected in SQL.
  const { expired: rotatedPairs } = await expireStaleReciprocalPairs(adminClient)
  console.log(`[Weekly Generation] Rotation: expired ${rotatedPairs} stale reciprocal pair(s).`)

  let generated = 0
  let generationDisabledSkipped = 0 // eligible but generation gated off (admin batch is canonical)
  let skippedUnresolved = 0   // ineligible because they still have unresolved introductions
  let skippedOther = 0        // ineligible for another reason (e.g. lingering queued batch)
  let placedNothing = 0
  let reminderSent = 0
  let reminderAlreadyHandled = 0
  let reminderFailed = 0
  // The reminder cycle id (ISO week). A retry/duplicate invocation of THIS week's run
  // shares the same cycleKey, so the durable per-cycle marker in
  // notifyPendingIntrosActionNeeded suppresses duplicate emails across invocations.
  const cycleKey = isoWeekKey(new Date())
  // Cheap intra-run guard (the durable marker is the cross-invocation guarantee).
  const reminded = new Set<string>()
  for (const user of users) {
    try {
      const elig = await evaluateWeeklyEligibility(adminClient, user.id)
      if (!elig.eligible) {
        // Members skipped BECAUSE they still have unresolved introductions get exactly
        // one "action needed" reminder per weekly cycle. Best-effort: runs AFTER the skip
        // decision and can neither generate a batch nor change eligibility.
        if (elig.unresolvedCount > 0) {
          skippedUnresolved++
          if (!reminded.has(user.id)) {
            reminded.add(user.id)
            const r = await notifyPendingIntrosActionNeeded(user.id, elig.activeBatchId, cycleKey)
            if (r.alreadyHandled) reminderAlreadyHandled++
            else if (r.emailed || r.skipped) reminderSent++  // sent, or preference-suppressed (handled)
            else reminderFailed++                            // hard send failure → retryable
          }
        } else {
          skippedOther++
        }
        continue
      }
      // ELIGIBLE. Generation is the admin batch's job (canonical); only generate here when
      // explicitly re-enabled. Otherwise the member's new batch comes from the admin Send.
      if (!WEEKLY_REFRESH_GENERATION) { generationDisabledSkipped++; continue }
      // Routed through the ONE reciprocal, concurrency-safe path (not the legacy one-sided enqueue).
      const result = await generateReciprocalBatchForMember(user.id, 'weekly')
      if (result.count > 0) generated++
      else placedNothing++
    } catch (err) {
      console.error(`[Weekly Generation] Error for ${user.email}:`, err)
    }
  }

  console.log(`[Weekly Generation] Complete (cycle ${cycleKey}, generation=${WEEKLY_REFRESH_GENERATION ? 'ON' : 'OFF (admin canonical)'}). Generated ${generated}; ${generationDisabledSkipped} eligible-not-generated; skipped ${skippedUnresolved} (unresolved) + ${skippedOther} (other); ${placedNothing} no candidates. Reminders: ${reminderSent} sent/handled, ${reminderAlreadyHandled} already-handled (dedup), ${reminderFailed} failed (retryable).`)
  return NextResponse.json({
    success: true,
    cycleKey,
    generationEnabled: WEEKLY_REFRESH_GENERATION,
    generated,
    generationDisabledSkipped,
    skippedUnresolved,
    skippedOther,
    placedNothing,
    reminderSent,
    reminderAlreadyHandled,
    reminderFailed,
  })
}
