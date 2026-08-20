import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createNotificationSafe } from '@/lib/notifications'
import { countUnresolvedRecommendations, EXPRESSED_INTEREST_STATUSES } from '@/lib/introductions/queue'
import {
  isWednesdayInNewYork, newYorkIsoWeekKey, openCardsFor, reminderIneligibility,
  REMINDER_PURPOSE, type OpenCard, type ReminderProfile,
} from '@/lib/reminders/wednesdayIntroReminder'
import { claimReminder, markAccepted, markFailed } from '@/lib/reminders/deliveryLedger'
import { runExpiryStage } from '@/lib/introductions/expiryWorker'
import { sendWednesdayIntroReminderEmail } from '@/lib/email'

/**
 * RESERVED STAGE BUDGETS. Each stage gets its own wall-clock slice measured from ITS OWN start, so
 * neither can starve the other: an expiry backlog cannot delay the Wednesday email past its window,
 * and the reminder cannot consume the whole invocation. The pre-existing PART 3/PART 4 work runs
 * first and is untouched.
 */
const REMINDER_PAGE = 1000
const REMINDER_MAX_PER_RUN = 300
const REMINDER_DEADLINE_MS = 25_000   // Wednesday reminder stage
const EXPIRY_BUDGET_MS = 15_000       // daily expiry stage, strictly after the reminder
/** Statuses the Wednesday scan must read: open cards plus every status that counts as a RESPONSE. */
const REMINDER_RELEVANT_STATUSES = [
  'suggested', 'pending', 'accepted', 'accepted_pending_payment', 'admin_pending', 'approved',
  'passed', 'declined', 'rejected', 'hidden', 'hidden_permanent', 'expired', 'archived',
]
import { sendIntroductionReminderEmail, sendWaitingResponseEmail } from '@/lib/email'
import {
  shouldRemindWaiting,
  classifyIntroReminder,
  INTRO_REMINDER_STALE_MS,
  WAITING_RESPONSE_THRESHOLD_MS,
} from '@/lib/notifications/engagement'
import { fetchActionableIncomingInterest } from '@/lib/introductions/incomingInterest'

// A member has "taken action" on an introduction if they expressed interest in one
// (any EXPRESSED_INTEREST status) or passed on one. Used to split no_action vs partial.
const INTRO_ACTION_STATUSES = [...EXPRESSED_INTEREST_STATUSES, 'passed'] as string[]

/**
 * Engagement reminders (runs daily).
 *
 *  • PART 4 — "Someone is waiting on your response": every day, any member-initiated
 *    expressed-interest (`approved`) row older than 48h nudges the counterpart once,
 *    BUT only when that item is an ACTIONABLE incoming-interest item for the
 *    recipient per fetchActionableIncomingInterest — the exact same source of truth
 *    the Introductions "Interested in you" surface renders. So a reminder is sent
 *    only when the recipient will actually see, and can immediately act on, the
 *    item (excludes matched pairs, deactivated expressers, same-company, and
 *    admin-initiated rows by construction). One nudge per surfaced row
 *    (dedupeKey `waiting:<id>`).
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
  const startedAt = Date.now()
  const hasResend = !!process.env.RESEND_API_KEY

  // ── PART 4: "Someone is waiting on your response" (daily) ──────────────────
  let waitingSent = 0
  let waitingSkipped = 0
  const waitingCutoff = new Date(now - WAITING_RESPONSE_THRESHOLD_MS).toISOString()
  const { data: approvedRows } = await admin
    .from('intro_requests')
    .select('id, requester_id, target_user_id, status, updated_at, is_admin_initiated')
    .eq('status', 'approved')
    .eq('is_admin_initiated', false)
    .lte('updated_at', waitingCutoff)

  // Cache the recipient's actionable incoming-interest set (the SAME query the
  // "Interested in you" surface uses) so the reminder can never point at something
  // the page won't show. Computed once per recipient.
  const actionableByWaiter = new Map<string, Set<string>>()

  for (const row of approvedRows ?? []) {
    const expresserId = row.requester_id // expressed interest → approved their outbound rec
    const waiterId = row.target_user_id  // the counterpart who must respond

    // Threshold/status guard (defensive; the query already filters both).
    if (!shouldRemindWaiting({ status: row.status, createdAt: row.updated_at, now })) {
      waitingSkipped++; continue
    }

    // Single source of truth: only nudge if THIS row is a live, actionable incoming
    // item the recipient can act on right now (fetchActionableIncomingInterest
    // already excludes matched pairs, deactivated expressers, same-company, and
    // admin rows). If it isn't surfaced, no reminder — ever.
    let actionable = actionableByWaiter.get(waiterId)
    if (!actionable) {
      const items = await fetchActionableIncomingInterest(admin, waiterId, { viaServiceRole: true })
      actionable = new Set(items.map((i) => i.introRequestId))
      actionableByWaiter.set(waiterId, actionable)
    }
    if (!actionable.has(row.id)) { waitingSkipped++; continue }

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

    // Aggregate only — the request and recipient UUIDs used to be interpolated here.
    console.log('[Email] type=waiting_response')
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

    // Aggregate only: the member and batch UUIDs used to be interpolated here. An operator can
      // re-derive them from the batch; a log line is the wrong place for identities.
      console.log(`[Email] type=introduction_reminder count=${unresolved} category=${category}`)
    try {
      if (hasResend) await sendIntroductionReminderEmail(p.email, p.full_name || 'there', unresolved, category)
      reminderSent++
    } catch (e: any) {
      console.error('[engagement-reminders] reminder email failed (non-fatal):', e?.message)
    }
  }

  console.log(`[engagement-reminders] done — waiting sent:${waitingSent} skipped:${waitingSkipped}; reminder sent:${reminderSent} skipped:${reminderSkipped}`)
  // ── PART 5: WEDNESDAY consolidated unanswered-introduction reminder ─────────
  //
  // WHY THIS EXISTS ALONGSIDE PART 3. Part 3 keys on an ACTIVE recommendation_batches envelope and
  // dedupes per batch_id. Reciprocal cards have batch_id NULL and no envelope, so those members were
  // never reminded at all; and migration 064 reuses an envelope across review cycles, so a second
  // card added later found the one dedupe key already spent. Part 5 keys on the CARD and on
  // member+ISO-week, and reads no batch table.
  //
  // ONE consolidated email per qualifying member per week, however many cards they hold.
  let wedConsidered = 0, wedClaimed = 0, wedSent = 0, wedFailed = 0
  const wedSkip: Record<string, number> = {}
  let wedTruncated = false

  if (isWednesdayInNewYork(new Date(now))) {
    // Measured from THIS stage's start, not the route's: the pre-existing PART 3/PART 4 work must
    // not consume the reminder's reserved slice.
    const wedStartedAt = Date.now()
    const cycleKey = newYorkIsoWeekKey(new Date(now))
    // Paged to exhaustion. An unbounded select is capped by PostgREST, which would silently drop
    // recipients — the same failure mode that let already-full members into a batch.
    const openRows: OpenCard[] = []
    let readFailed = false
    for (let from = 0; ; from += REMINDER_PAGE) {
      const { data, error } = await admin
        .from('intro_requests')
        .select('requester_id, target_user_id, status')
        .in('status', REMINDER_RELEVANT_STATUSES)
        .range(from, from + REMINDER_PAGE - 1)
      if (error) {
        // FAIL CLOSED. Sending on a partial read would email the wrong people and mis-state counts.
        console.error('[engagement-reminders] wednesday read failed (class):', error.code ?? 'unknown')
        readFailed = true
        break
      }
      for (const r of data ?? []) {
        if (!r?.requester_id || !r?.target_user_id || !r?.status) continue
        openRows.push({ requesterId: r.requester_id, targetUserId: r.target_user_id, status: r.status, pairId: null })
      }
      if (!data || data.length < REMINDER_PAGE) break
    }

    if (!readFailed) {
      const byMember = new Map<string, number>()
      const memberIds = new Set(openRows.map((r) => r.requesterId))
      for (const id of Array.from(memberIds)) {
        const open = openCardsFor(id, openRows)
        if (open.length > 0) byMember.set(id, open.length)
      }
      // Deterministic, oldest-member-id-first, and BOUNDED. Anything beyond the cap is reported and
      // picked up by the next invocation rather than silently dropped.
      const candidates = Array.from(byMember.entries()).sort((a, b) => a[0].localeCompare(b[0]))
      if (candidates.length > REMINDER_MAX_PER_RUN) wedTruncated = true

      for (const [memberId, openCount] of candidates.slice(0, REMINDER_MAX_PER_RUN)) {
        if (Date.now() - wedStartedAt > REMINDER_DEADLINE_MS) { wedTruncated = true; break }
        wedConsidered++
        const { data: prof } = await admin
          .from('profiles')
          .select('id, email, full_name, account_status, profile_complete, is_test_account, is_admin, matching_paused')
          .eq('id', memberId)
          .maybeSingle()
        const p: ReminderProfile = {
          id: memberId,
          email: prof?.email ?? null,
          firstName: (prof?.full_name ?? '').split(' ')[0] || null,
          accountStatus: prof?.account_status ?? null,
          profileComplete: prof?.profile_complete ?? null,
          isTestAccount: prof?.is_test_account ?? null,
          isAdmin: prof?.is_admin ?? null,
          matchingPaused: prof?.matching_paused ?? null,
        }
        const reason = reminderIneligibility(p, openCount)
        if (reason) { wedSkip[reason] = (wedSkip[reason] ?? 0) + 1; continue }

        const claim = await claimReminder(admin, {
          memberId, purpose: REMINDER_PURPOSE, cycleKey, openCardCount: openCount,
        })
        if (!claim.claimed || !claim.deliveryId) {
          wedSkip[claim.errorClass ?? 'already_claimed'] = (wedSkip[claim.errorClass ?? 'already_claimed'] ?? 0) + 1
          continue
        }
        wedClaimed++
        try {
          const res = await sendWednesdayIntroReminderEmail(p.email as string, p.firstName, openCount)
          if (res.sent) { await markAccepted(admin, claim.deliveryId, res.providerMessageId); wedSent++ }
          else { wedSkip['pref_disabled'] = (wedSkip['pref_disabled'] ?? 0) + 1 }
        } catch {
          // Retryable: 'failed' sits outside the active-claim index, so the next run may re-claim.
          await markFailed(admin, claim.deliveryId, 'provider_error')
          wedFailed++
        }
      }
    } else {
      wedSkip['read_failed_no_sends'] = 1
    }
  }

  // ── PART 6: bounded DAILY suggested-card expiry ─────────────────────────────
  //
  // This route is the one we can SEE running in production; /api/cron/expire-pending-intros is
  // configured in vercel.json but was not observed registered, and Vercel Hobby runs only two cron
  // jobs. Capacity recovery therefore cannot depend on that route existing. It runs the same shared
  // stage, so scheduling it changes nothing except how often expiry happens.
  //
  // Runs AFTER the reminder stage and on its own budget, so a backlog here can never delay or
  // starve the Wednesday email. A failure is reported coarsely and cannot corrupt the reminder work
  // that already completed.
  let expiry: Awaited<ReturnType<typeof runExpiryStage>> | { error: string }
  try {
    expiry = await runExpiryStage(admin, { budgetMs: EXPIRY_BUDGET_MS })
  } catch {
    // CLASS only — no identity, no raw error. The reminder results above still stand.
    console.error('[engagement-reminders] expiry stage failed (class): unhandled')
    expiry = { error: 'expiry_stage_failed' }
  }

  return NextResponse.json({
    wednesdayReminder: {
      ranToday: isWednesdayInNewYork(new Date(now)),
      considered: wedConsidered, claimed: wedClaimed, sent: wedSent, failed: wedFailed,
      truncated: wedTruncated, skipped: wedSkip,
    },
    suggestedExpiry: expiry, waitingSent, waitingSkipped, reminderSent, reminderSkipped })
}
