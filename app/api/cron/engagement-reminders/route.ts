import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createNotificationSafe } from '@/lib/notifications'
import { runPostBatchReferralNudge } from '@/lib/referralCampaign/postBatchNudge'
import { countUnresolvedRecommendations, EXPRESSED_INTEREST_STATUSES } from '@/lib/introductions/queue'
import {
  isWednesdayInNewYork,
  REMINDER_RELEVANT_STATUSES, newYorkIsoWeekKey, openCardsFor, reminderIneligibility,
  REMINDER_PURPOSE, type OpenCard, type ReminderProfile,
} from '@/lib/reminders/wednesdayIntroReminder'
import { claimReminder, markAccepted, markFailed } from '@/lib/reminders/deliveryLedger'
import { runExpiryStage } from '@/lib/introductions/expiryWorker'
import { runCreditBlockedSweep } from '@/lib/introductions/creditBlockedSweep'
import { drainIntroductionOutbox } from '@/lib/introductions/newIntroductionOutbox'
import { purgeExpiredDeletionEvents } from '@/lib/account/retentionPurge'
import { runOnboardingReminderStage, REMINDER_STAGE_BUDGET_MS } from '@/lib/onboarding/reminderWorker'
import { runCapacityReleaseStage, RELEASE_STAGE_BUDGET_MS } from '@/lib/introductions/capacityRelease'
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
/** Ids per profiles read. Keeps the URL well inside PostgREST's limit on a large `.in()`. */
const PROFILE_FETCH_CHUNK = 200
/** Members whose claim+send+mark run concurrently. Matches the referral campaign's batch size. */
const REMINDER_SEND_CONCURRENCY = 25
const EXPIRY_BUDGET_MS = 15_000       // daily expiry stage, strictly after the reminder
const CREDIT_RETRY_BUDGET_MS = 8_000  // mutual matches blocked on credits
const OUTBOX_STAGE_BUDGET_MS = 12_000 // daily new-introduction outbox drain, strictly last
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

  // ── Referral ask, gated on having SEEN the product work ────────────────────────────────────────
  // Lives here rather than in its own cron for two reasons: this is already the member-nudge job,
  // and the project is at ten scheduled functions, so an eleventh is a plan question rather than a
  // technical one. It is also the right neighbour — the loop above reminds members about cards they
  // have not answered, and this one deliberately skips exactly those members.
  //
  // Safe to run daily: the dedupeKey caps a member at one notification ever, so this converges.
  let referralNudge = { notified: 0, deduped: 0, held: 0, considered: 0 }
  try {
    referralNudge = await runPostBatchReferralNudge(admin)
  } catch (e: any) {
    // Never let a campaign nudge break the reminders this cron exists for.
    console.error('[engagement-reminders] referral nudge failed (non-blocking):', e?.message)
  }

  console.log(`[engagement-reminders] done — waiting sent:${waitingSent} skipped:${waitingSkipped}; reminder sent:${reminderSent} skipped:${reminderSkipped}; referral notified:${referralNudge.notified} deduped:${referralNudge.deduped} held:${referralNudge.held}`)
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
      // ONE profiles read for everyone referenced by any card — requesters AND targets. Previously
      // this was a round trip PER MEMBER inside the send loop, which is what actually consumed the
      // 25s budget: at a few hundred milliseconds each, the deadline fired around 60-100 members and
      // everyone after it was cut. Targets are included because openCardsFor now needs to know which
      // of them are active.
      const referenced = new Set<string>()
      for (const r of openRows) { referenced.add(r.requesterId); referenced.add(r.targetUserId) }
      const profById = new Map<string, any>()
      const refIds = Array.from(referenced)
      for (let i = 0; i < refIds.length; i += PROFILE_FETCH_CHUNK) {
        const { data, error } = await admin
          .from('profiles')
          .select('id, email, full_name, account_status, profile_complete, is_test_account, is_admin, matching_paused')
          .in('id', refIds.slice(i, i + PROFILE_FETCH_CHUNK))
        // FAIL CLOSED, same rule as the card read: a partial profile set would mis-classify targets
        // as inactive and silently suppress real reminders.
        if (error) { readFailed = true; break }
        for (const row of data ?? []) profById.set(row.id, row)
      }

      const activeTargetIds = new Set<string>()
      for (const [id, row] of Array.from(profById.entries())) {
        if (row?.account_status === 'active') activeTargetIds.add(id)
      }

      const byMember = new Map<string, number>()
      const memberIds = new Set(openRows.map((r) => r.requesterId))
      for (const id of Array.from(memberIds)) {
        const open = openCardsFor(id, openRows, activeTargetIds)
        if (open.length > 0) byMember.set(id, open.length)
      }

      // LEAST-RECENTLY-REMINDED FIRST, never-reminded ahead of everyone.
      //
      // The old order was member UUID ascending. Deterministic, but the deadline then cut the same
      // tail of that sort every week — and because this stage only runs on Wednesdays, "picked up by
      // the next invocation" meant seven days later, with the identical ordering and the identical
      // cut. The same members were starved indefinitely rather than occasionally. Ordering by last
      // reminder makes any future cut ROTATE: whoever is dropped this week sorts first next week.
      const lastRemindedAt = new Map<string, string>()
      const { data: priorDeliveries } = await admin
        .from('reminder_deliveries')
        .select('member_id, claimed_at')
        .eq('purpose', REMINDER_PURPOSE)
        .order('claimed_at', { ascending: false })
      for (const d of (priorDeliveries ?? []) as any[]) {
        if (!lastRemindedAt.has(d.member_id)) lastRemindedAt.set(d.member_id, d.claimed_at)
      }
      const candidates = Array.from(byMember.entries()).sort((a, b) => {
        const la = lastRemindedAt.get(a[0]) ?? ''   // '' sorts first — never reminded goes to the front
        const lb = lastRemindedAt.get(b[0]) ?? ''
        if (la !== lb) return la < lb ? -1 : 1
        return a[0].localeCompare(b[0])             // stable tie-break, so a run is still reproducible
      })
      if (candidates.length > REMINDER_MAX_PER_RUN) wedTruncated = true

      // Eligibility is now PURE — the profiles are already in memory — so it is settled for the
      // whole cohort up front, before any I/O. Only genuine recipients reach the send phase.
      const recipients: Array<{ p: ReminderProfile; openCount: number }> = []
      for (const [memberId, openCount] of candidates.slice(0, REMINDER_MAX_PER_RUN)) {
        wedConsidered++
        const prof = profById.get(memberId)
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
        recipients.push({ p, openCount })
      }

      // Claim + send + mark, REMINDER_SEND_CONCURRENCY at a time. Each member's three round trips
      // stay sequential relative to each other — the claim must land before the send, and the send
      // before the mark — but different members no longer wait on one another. That is what removes
      // the truncation: the stage's cost becomes roughly total/concurrency instead of total.
      //
      // Concurrent claims are safe: reminder_deliveries' active-claim index is per
      // (member_id, purpose, cycle_key), so distinct members never contend.
      for (let i = 0; i < recipients.length; i += REMINDER_SEND_CONCURRENCY) {
        if (Date.now() - wedStartedAt > REMINDER_DEADLINE_MS) { wedTruncated = true; break }
        const chunk = recipients.slice(i, i + REMINDER_SEND_CONCURRENCY)
        await Promise.all(chunk.map(async ({ p, openCount }) => {
          const claim = await claimReminder(admin, {
            memberId: p.id, purpose: REMINDER_PURPOSE, cycleKey, openCardCount: openCount,
          })
          if (!claim.claimed || !claim.deliveryId) {
            const key = claim.errorClass ?? 'already_claimed'
            wedSkip[key] = (wedSkip[key] ?? 0) + 1
            return
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
        }))
      }
    } else {
      wedSkip['read_failed_no_sends'] = 1
    }
  }

  // ── PART 5b: retry mutual matches blocked on credits ────────────────────────
  //
  // Runs BEFORE expiry deliberately. A pair that completes here becomes a match, and expiry's
  // match_exists guard then protects it — whereas the reverse order would have expiry look at a
  // pair that was about to succeed. It is also strictly ahead of the expiry budget, so a backlog
  // there can never starve a match that is one credit away from completing.
  let creditRetry: Awaited<ReturnType<typeof runCreditBlockedSweep>> | { error: string }
  try {
    creditRetry = await runCreditBlockedSweep(admin, { budgetMs: CREDIT_RETRY_BUDGET_MS })
  } catch {
    console.error('[engagement-reminders] credit-blocked sweep failed (class): unhandled')
    creditRetry = { error: 'unhandled' }
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

  // ── PART 7: bounded DURABLE new-introduction outbox drain ───────────────────
  //
  // THIS IS THE RECOVERY PATH, and it is why a post-commit crash can no longer lose an email. The
  // migration-070 trigger writes an outbox event inside the transaction that commits a newly
  // visible card, so the obligation exists in the database whether or not the writing process
  // survived. Writers also drain eagerly for promptness, but nothing depends on that: anything they
  // missed is still sitting in the outbox and is sent here, daily.
  //
  // Runs last and on its own budget, so it can never delay the Wednesday email or the expiry stage.
  let introOutbox: Awaited<ReturnType<typeof drainIntroductionOutbox>> | { error: string }
  try {
    introOutbox = await drainIntroductionOutbox(admin, { budgetMs: OUTBOX_STAGE_BUDGET_MS })
  } catch {
    console.error('[engagement-reminders] intro outbox stage failed (class): unhandled')
    introOutbox = { error: 'intro_outbox_stage_failed' }
  }

  // ── PART 8: staged onboarding reminders (prospective invitations only) ──────
  //
  // Lives here rather than on a cron entry of its own because Vercel Hobby registers only a small
  // number of crons and this is a short bounded scan. Runs on its OWN budget, after every stage
  // above has completed, so a backlog of invitees can never delay the Wednesday reminder, the
  // expiry stage or the outbox drain.
  //
  // PROSPECTIVE ONLY: the worker scans rows with reminder_enrollment_at set, which is stamped from
  // migration 077 onward. The 117 historical invitees are never fetched and never evaluated; they
  // are reached only by the explicit admin catch-up campaign.
  let onboardingReminders: Awaited<ReturnType<typeof runOnboardingReminderStage>> | { error: string }
  try {
    onboardingReminders = await runOnboardingReminderStage(admin, { budgetMs: REMINDER_STAGE_BUDGET_MS })
  } catch {
    // CLASS only — no identity, no raw error. Every stage above still stands.
    console.error('[engagement-reminders] onboarding reminder stage failed (class): unhandled')
    onboardingReminders = { error: 'onboarding_reminder_stage_failed' }
  }

  // ── PART 9: introduction capacity release ───────────────────────────────────
  //
  // Frees a member's own hidden card from their visible capacity 72h after they expressed interest
  // in it. Default OFF: CAPACITY_RELEASE_MODE must be 'on' before a single row is written, and
  // 'dry_run' reports candidates while changing nothing.
  //
  // Runs on its OWN budget after every stage above has completed, so it can never delay the
  // Wednesday reminder, the expiry stage, the outbox drain or the onboarding reminders. It sends no
  // email and creates no notification — a release is internal accounting, and the replacement cards
  // announce themselves through the existing outbox when they are placed.
  let capacityRelease: Awaited<ReturnType<typeof runCapacityReleaseStage>> | { error: string }
  try {
    capacityRelease = await runCapacityReleaseStage(admin, { budgetMs: RELEASE_STAGE_BUDGET_MS })
  } catch {
    // CLASS only — no identity, no raw error. Every stage above still stands.
    console.error('[engagement-reminders] capacity release stage failed (class): unhandled')
    capacityRelease = { error: 'capacity_release_stage_failed' }
  }

  // ── PART 10: seven-year retention purge for the account-deletion ledger ──────
  //
  // Non-member-facing maintenance. It runs here rather than on a cron entry of its own because a
  // separate schedule would buy nothing: the work is a single bounded DELETE against a small table,
  // and Vercel Hobby runs a limited number of cron jobs, so an extra entry is a cost with no
  // benefit. Once per maintenance run is exactly the required cadence for a seven-year boundary.
  //
  // Runs LAST and cannot affect anything above it: the reminder, expiry and outbox stages have all
  // completed by this point, and a failure here is caught, classified and reported alongside their
  // results rather than replacing them. The seven-year cutoff is not expressed in application code
  // — the database function takes no arguments and no date.
  let ledgerRetention: Awaited<ReturnType<typeof purgeExpiredDeletionEvents>>
  try {
    ledgerRetention = await purgeExpiredDeletionEvents(admin)
  } catch {
    // Belt and braces: the helper already swallows its own failures.
    console.error('[engagement-reminders] ledger retention stage failed (class): unhandled')
    ledgerRetention = { removed: null, errorClass: 'unavailable' }
  }

  return NextResponse.json({
    introOutbox,
    // Aggregate count and a safe class only — never an id, a timestamp or a sample row.
    ledgerRetention,
    // Aggregate counts and coarse skip reasons only — never an address or a token.
    onboardingReminders,
    // Aggregate counts only — never a member id or an intro_request id.
    capacityRelease,
    wednesdayReminder: {
      ranToday: isWednesdayInNewYork(new Date(now)),
      considered: wedConsidered, claimed: wedClaimed, sent: wedSent, failed: wedFailed,
      truncated: wedTruncated, skipped: wedSkip,
    },
    creditRetry,
    suggestedExpiry: expiry, waitingSent, waitingSkipped, reminderSent, reminderSkipped })
}
