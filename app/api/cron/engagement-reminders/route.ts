import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createNotificationSafe } from '@/lib/notifications'
import { countUnresolvedRecommendations, EXPRESSED_INTEREST_STATUSES } from '@/lib/introductions/queue'
import { buildBidirectionalMatchFilter } from '@/lib/db/filters'
import { sendIntroductionReminderEmail, sendWaitingResponseEmail } from '@/lib/email'
import {
  shouldRemindWaiting,
  classifyIntroReminder,
  INTRO_REMINDER_STALE_MS,
  WAITING_RESPONSE_THRESHOLD_MS,
} from '@/lib/notifications/engagement'

// A member has "taken action" on an introduction if they expressed interest in one
// (any EXPRESSED_INTEREST status) or passed on one. Used to split no_action vs partial.
const INTRO_ACTION_STATUSES = [...EXPRESSED_INTEREST_STATUSES, 'passed'] as string[]

/**
 * Engagement reminders (runs daily).
 *
 *  • PART 4 — "Someone is waiting on your response": every day, any outbound
 *    expressed-interest (`approved`) row older than 48h whose counterpart hasn't
 *    responded yet nudges the counterpart once. Excludes already-matched pairs,
 *    counterparts who already acted (passed/hidden/declined/expressed), and
 *    inactive recipients. One nudge per approved row (dedupeKey `waiting:<id>`).
 *
 *  • PART 3 — weekly introduction reminder: on SUNDAYS only, any member whose
 *    active batch still has unresolved introductions gets one reminder. One
 *    reminder per weekly batch (dedupeKey `introreminder:<batchId>`), so a member
 *    is never reminded twice for the same batch even across Sundays.
 *
 * Idempotency/duplicate-send safety across workers is inherited from
 * createNotificationSafe (returns null on a duplicate); the email only fires when
 * a notification was newly created. Preference-awareness is inherited from the
 * send* functions (email_new_introductions; fail-open until preferences ship).
 */
export async function GET(req: Request) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const now = Date.now()
  const hasResend = !!process.env.RESEND_API_KEY

  // Reverse-side statuses that mean the counterpart has already acted on (or is
  // committed to) this pair — if any exist, there is nothing to wait on.
  const COUNTERPART_RESOLVED = new Set([
    'approved', 'pending', 'accepted', 'accepted_pending_payment', 'admin_pending',
    'passed', 'hidden', 'hidden_permanent', 'declined', 'rejected', 'expired', 'archived',
  ])

  // ── PART 4: "Someone is waiting on your response" (daily) ──────────────────
  let waitingSent = 0
  let waitingSkipped = 0
  const waitingCutoff = new Date(now - WAITING_RESPONSE_THRESHOLD_MS).toISOString()
  const { data: approvedRows } = await admin
    .from('intro_requests')
    .select('id, requester_id, target_user_id, status, updated_at')
    .eq('status', 'approved')
    .lte('updated_at', waitingCutoff)

  for (const row of approvedRows ?? []) {
    const expresserId = row.requester_id // expressed interest → approved their outbound rec
    const waiterId = row.target_user_id  // the counterpart who must respond

    // Threshold/status guard (defensive; the query already filters both).
    if (!shouldRemindWaiting({ status: row.status, createdAt: row.updated_at, now })) {
      waitingSkipped++; continue
    }

    // Already matched (either direction) → nothing to wait on.
    const { data: match } = await admin
      .from('matches')
      .select('id')
      .or(buildBidirectionalMatchFilter(expresserId, waiterId))
      .limit(1)
      .maybeSingle()
    if (match) { waitingSkipped++; continue }

    // Counterpart already acted on this pair (their reverse row is resolved) → skip.
    const { data: reverse } = await admin
      .from('intro_requests')
      .select('status')
      .eq('requester_id', waiterId)
      .eq('target_user_id', expresserId)
    if ((reverse ?? []).some((r: any) => COUNTERPART_RESOLVED.has(r.status))) {
      waitingSkipped++; continue
    }

    // Recipient must be active and have an email.
    const { data: waiter } = await admin
      .from('profiles')
      .select('email, full_name, account_status')
      .eq('id', waiterId)
      .maybeSingle()
    if (!waiter || waiter.account_status !== 'active' || !waiter.email) {
      waitingSkipped++; continue
    }

    // One nudge per approved intro request (race-safe via dedupeKey).
    const created = await createNotificationSafe({
      userId: waiterId,
      type: 'waiting_response',
      data: { introRequestId: row.id, fromUserId: expresserId },
      dedupeKey: `waiting:${row.id}`,
    })
    if (!created) { waitingSkipped++; continue }

    console.log(`[Email] type=waiting_response introRequestId=${row.id} recipientId=${waiterId}`)
    try {
      if (hasResend) await sendWaitingResponseEmail(waiter.email, waiter.full_name || 'there')
      waitingSent++
    } catch (e: any) {
      console.error('[engagement-reminders] waiting email failed (non-fatal):', e?.message)
    }
  }

  // ── PART 3: introduction reminder — ACTIVE batch, unresolved, ≥7 days stale ──
  // Only reads active recommendation_batches (never queued), so a member's queued
  // next batch is never revealed. Fires once per batch, ~7 days after it became
  // visible, with copy chosen by engagement (no_action vs partial). Resolved batches
  // get nothing. The dedupeKey enforces exactly one reminder per batch.
  let reminderSent = 0
  let reminderSkipped = 0
  const staleCutoff = new Date(now - INTRO_REMINDER_STALE_MS).toISOString()
  const { data: activeBatches } = await admin
    .from('recommendation_batches')
    .select('batch_id, member_id, displayed_at')
    .eq('state', 'active')
    .lte('displayed_at', staleCutoff) // 7-day gate (null displayed_at is excluded)

  for (const b of activeBatches ?? []) {
    const unresolved = await countUnresolvedRecommendations(admin, b.member_id)
    // Has the member engaged with any introduction at all (expressed interest / passed)?
    const { data: acted } = await admin
      .from('intro_requests')
      .select('id')
      .eq('requester_id', b.member_id)
      .in('status', INTRO_ACTION_STATUSES)
      .limit(1)
    const category = classifyIntroReminder({ unresolvedCount: unresolved, hasTakenAnyAction: (acted ?? []).length > 0 })
    if (category === 'none') { reminderSkipped++; continue } // resolved batch → no reminder

    const { data: p } = await admin
      .from('profiles')
      .select('email, full_name, account_status, is_test_account')
      .eq('id', b.member_id)
      .maybeSingle()
    if (!p || p.account_status !== 'active' || p.is_test_account || !p.email) {
      reminderSkipped++; continue
    }

    // One reminder per batch (survives re-runs and repeated daily crons), race-safe.
    const created = await createNotificationSafe({
      userId: b.member_id,
      type: 'introduction_reminder',
      data: { batchId: b.batch_id, count: unresolved, category },
      dedupeKey: `introreminder:${b.batch_id}`,
    })
    if (!created) { reminderSkipped++; continue }

    console.log(`[Email] type=introduction_reminder memberId=${b.member_id} batchId=${b.batch_id} count=${unresolved} category=${category}`)
    try {
      if (hasResend) await sendIntroductionReminderEmail(p.email, p.full_name || 'there', unresolved, category)
      reminderSent++
    } catch (e: any) {
      console.error('[engagement-reminders] reminder email failed (non-fatal):', e?.message)
    }
  }

  console.log(`[engagement-reminders] done — waiting sent:${waitingSent} skipped:${waitingSkipped}; reminder sent:${reminderSent} skipped:${reminderSkipped}`)
  return NextResponse.json({ waitingSent, waitingSkipped, reminderSent, reminderSkipped })
}
