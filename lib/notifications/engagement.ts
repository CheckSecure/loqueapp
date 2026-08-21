import { createAdminClient } from '@/lib/supabase/admin'
import { createNotificationSafe } from '@/lib/notifications'

/**
 * Engagement email helpers built on the EXISTING notification/email/cron stack.
 *
 * Design notes:
 *  - Idempotency reuses `createNotificationSafe`'s dedupeKey (backed by the
 *    partial-unique index notifications_user_type_dedupe_key_uniq, migration 006):
 *    it returns the row only when NEWLY created and null on a duplicate, so we get
 *    "one email per event" and multi-worker safety for free.
 *  - Preferences: the underlying send* functions call isPrefEnabled, which
 *    FAIL-OPENS today because notification_preferences isn't applied in prod yet
 *    (migration 002). Once that migration lands, every email here automatically
 *    starts respecting the user's category preference — no change needed here.
 *  - The actual Resend call is gated on RESEND_API_KEY so unit tests never hit
 *    the network; the pure decision functions below carry the testable logic.
 */

// ── Pure decision helpers (unit-tested) ───────────────────────────────────────

/** A batch is emailable only when it becomes VISIBLE (placed as the active batch),
 *  never for a hidden queued batch. Covers weekly, onboarding, and promotions. */
export function shouldNotifyVisibleBatch(
  result: { placed?: boolean; visiblePlaced?: number } | null | undefined,
): boolean {
  // A placement can now fill BOTH tiers in one call, so "did this become visible" is no longer a
  // property of the batch as a whole — it is whether any card actually landed in the VISIBLE tier.
  // Announcing on `state === 'active'` would have emailed about reservations nobody can see.
  return !!result && result.placed === true && (result.visiblePlaced ?? 0) > 0
}

/** Recipient is "currently active" if they touched the app within this window. */
export const MESSAGE_EMAIL_ACTIVE_WINDOW_MS = 15 * 60 * 1000

/** Email a new message only when the recipient is away AND they don't already
 *  have an unread nudge for this conversation (avoids per-message spam). */
export function shouldEmailNewMessage(args: {
  recipientLastActiveAt: string | null | undefined
  hasOtherUnreadInConversation: boolean
  now?: number
}): boolean {
  if (args.hasOtherUnreadInConversation) return false
  const now = args.now ?? Date.now()
  const last = args.recipientLastActiveAt ? new Date(args.recipientLastActiveAt).getTime() : 0
  return !last || now - last > MESSAGE_EMAIL_ACTIVE_WINDOW_MS
}

/** "Someone is waiting on your response" fires 48h after interest was expressed. */
export const WAITING_RESPONSE_THRESHOLD_MS = 48 * 60 * 60 * 1000

/** Only an outstanding expressed-interest row (`approved`) past the threshold and
 *  not yet connected qualifies. matched/declined/passed/expired/hidden are excluded
 *  by never being `approved` here (matched pairs are filtered by the caller). */
export function shouldRemindWaiting(args: { status: string; createdAt: string; alreadyMatched?: boolean; now?: number }): boolean {
  if (args.status !== 'approved') return false
  if (args.alreadyMatched) return false
  const now = args.now ?? Date.now()
  return now - new Date(args.createdAt).getTime() >= WAITING_RESPONSE_THRESHOLD_MS
}

/** Intro reminder: the member still has unresolved visible introductions and hasn't
 *  already been reminded for this batch (one reminder per weekly batch). */
export function shouldSendIntroReminder(unresolvedCount: number, alreadyReminded: boolean): boolean {
  return unresolvedCount > 0 && !alreadyReminded
}

/** A batch is only stale enough to remind on once it has been visible this long. */
export const INTRO_REMINDER_STALE_MS = 7 * 24 * 60 * 60 * 1000

export type IntroReminderCategory = 'none' | 'no_action' | 'partial'

/**
 * Classify a member's engagement with their ACTIVE introduction batch:
 *   • none      → nothing unresolved (fully reviewed) → no reminder;
 *   • no_action → has unresolved intros AND has taken no action at all (highest priority);
 *   • partial   → has unresolved intros but has expressed interest / passed on some.
 * Purely a function of the two facts the cron already computes; drives which copy is sent.
 */
export function classifyIntroReminder(args: { unresolvedCount: number; hasTakenAnyAction: boolean }): IntroReminderCategory {
  if (args.unresolvedCount <= 0) return 'none'
  return args.hasTakenAnyAction ? 'partial' : 'no_action'
}

/**
 * Category-specific introduction-reminder copy (PURE — unit-tested; lives here rather than
 * in email.ts so it carries no transport dependency). Both variants link only to the
 * member's CURRENT introductions, never a queued next batch, so an upcoming batch is never
 * revealed early. `no_action` (highest priority) vs `partial` engagement.
 */
export function introReminderCopy(
  category: Exclude<IntroReminderCategory, 'none'>,
  introCount: number,
): { subject: string; heading: string; body: string; cta: string } {
  const noun = introCount === 1 ? 'introduction' : 'introductions'
  if (category === 'partial') {
    return {
      subject: `You're almost there — ${introCount} ${noun} left to review`,
      heading: 'Almost there',
      body: `Thanks for engaging with your introductions.<br/><br/>You still have ${introCount} left to review. Once you've completed these, we'll prepare your next round of connections.`,
      cta: 'Finish reviewing',
    }
  }
  return {
    subject: 'Your Andrel introductions are waiting — take 2 minutes',
    heading: 'Your introductions are waiting',
    body: `You have ${introCount} curated ${noun} waiting for your review.<br/><br/>A quick Express interest or Pass helps us understand your network preferences and unlock your next round of connections.<br/><br/>Take two minutes to review your introductions.`,
    cta: 'Review Introductions',
  }
}

// ── Wiring (best-effort; used by producers) ───────────────────────────────────

/**
 * Notify a member that a batch just became visible: one in-app `new_batch`
 * notification + one `sendNewBatchEmail` per batch (idempotent via dedupeKey).
 * Best-effort — never throws, so it can't break generation/promotion.
 */
export async function notifyNewVisibleBatch(memberId: string, batchId: string, count?: number): Promise<void> {
  try {
    const admin = createAdminClient()
    let n = count
    if (n == null) {
      const { count: c } = await admin
        .from('intro_requests')
        .select('id', { count: 'exact', head: true })
        .eq('requester_id', memberId)
        .eq('batch_id', batchId)
        .eq('status', 'suggested')
      n = c ?? 0
    }
    if (!n) return // nothing visible → nothing to announce

    // Idempotent: one notification + email per batch (dedupeKey), race-safe.
    const created = await createNotificationSafe({
      userId: memberId,
      type: 'new_batch',
      data: { batchId, count: n },
      dedupeKey: `batch:${batchId}`,
    })
    if (!created) return // duplicate → this batch was already announced

    // EMAIL IS NOT SENT HERE. The announcement was already recorded DURABLY by the migration-070
    // trigger, inside the transaction that committed the card, so it cannot be lost if this
    // process dies. This drain is promptness only — the scheduled stage in engagement-reminders
    // sends it regardless. The in-app `new_batch` notification above is unchanged.
    const { drainForMember } = await import('@/lib/introductions/newIntroductionOutbox')
    await drainForMember(admin, memberId)
  } catch (e: any) {
    console.error('[engagement] notifyNewVisibleBatch failed (non-fatal):', e?.message)
  }
}

/**
 * Notify a member that an ADMIN-APPROVED batch is visible now. Identical dedupe to
 * notifyNewVisibleBatch (one `new_batch` notification per batch, dedupeKey `batch:<id>`,
 * race-safe) but sends the dedicated admin-approval email — so the SHARED
 * sendNewBatchEmail used by weekly/onboarding/promotion is left untouched. Best-effort.
 */
export async function notifyAdminBatchReady(memberId: string, batchId: string, count?: number): Promise<void> {
  try {
    const admin = createAdminClient()
    let n = count
    if (n == null) {
      const { count: c } = await admin
        .from('intro_requests')
        .select('id', { count: 'exact', head: true })
        .eq('requester_id', memberId)
        .eq('batch_id', batchId)
        .eq('status', 'suggested')
      n = c ?? 0
    }
    if (!n) return // nothing visible → nothing to announce

    const created = await createNotificationSafe({
      userId: memberId,
      type: 'new_batch',
      data: { batchId, count: n },
      dedupeKey: `batch:${batchId}`,
    })
    if (!created) return // duplicate → this batch was already announced

    // Same as notifyNewVisibleBatch: the in-app notification stays here; the email is owed by the
    // durable outbox row the trigger already wrote, and this only drains it sooner.
    const { drainForMember } = await import('@/lib/introductions/newIntroductionOutbox')
    await drainForMember(admin, memberId)
  } catch (e: any) {
    console.error('[engagement] notifyAdminBatchReady failed (non-fatal):', e?.message)
  }
}

/**
 * Notify a member whose freshly-approved admin batch was QUEUED (hidden) because they
 * still have unresolved introductions in their CURRENT active batch. Sends the
 * "finish your current introductions" email immediately — never revealing the queued
 * batch (no counts/names; the email links only to current introductions). Idempotent:
 * one nudge per queued batch (dedupeKey `queuedwaiting:<queuedBatchId>`), so an
 * approve-batch retry can't duplicate it. Best-effort — never throws.
 *
 * The CALLER is responsible for only invoking this when the member actually has
 * unresolved current intros (via countUnresolvedRecommendations); this helper does not
 * read or change any queue/promotion state.
 */
export async function notifyQueuedIntrosWaiting(memberId: string, queuedBatchId: string): Promise<void> {
  try {
    const admin = createAdminClient()
    const created = await createNotificationSafe({
      userId: memberId,
      type: 'introductions_waiting',
      data: { batchId: queuedBatchId },
      dedupeKey: `queuedwaiting:${queuedBatchId}`,
    })
    if (!created) return // already nudged for this queued batch

    const { data: p } = await admin.from('profiles').select('email, full_name').eq('id', memberId).maybeSingle()
    if (p?.email && process.env.RESEND_API_KEY) {
      console.log('[Email] type=introductions_waiting')
      const { sendCurrentIntroductionsWaitingEmail } = await import('@/lib/email')
      await sendCurrentIntroductionsWaitingEmail(p.email, p.full_name || 'there')
    }
  } catch (e: any) {
    console.error('[engagement] notifyQueuedIntrosWaiting failed (non-fatal):', e?.message)
  }
}

/** Stable ISO-week key (UTC), e.g. "2026-W32", used as the weekly reminder cycle id. */
export function isoWeekKey(d: Date): string {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = dt.getUTCDay() || 7
  dt.setUTCDate(dt.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((dt.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/**
 * PART 3 — Notify a member SKIPPED from the weekly refresh because they still have
 * unresolved introductions. Sends the "Action needed before your next introductions"
 * email AND creates the in-app notification (reusing the 'introductions_waiting' type +
 * /dashboard/introductions link).
 *
 * DURABLY IDEMPOTENT per weekly cycle (`cycleKey`, an ISO week): a notification row with
 * dedupeKey `actionneeded:<cycleKey>` is the persistent "handled" marker.
 *   1. If that marker already exists → already handled this cycle → send NOTHING.
 *   2. Otherwise send the email.
 *   3. Record the marker (+ in-app notification) ONLY after the email SUCCEEDS or is
 *      preference-suppressed. A hard Resend FAILURE records nothing, so a later retry of
 *      the same weekly run re-sends (failure isn't permanently suppressed).
 * Result: a second/duplicate invocation of the same weekly run sends 0 duplicate emails,
 * while a genuine send failure remains retryable. Best-effort — NEVER throws, so it can
 * never alter eligibility or create a batch. The unique dedupe index collapses a
 * concurrent double-insert to one row.
 */
export async function notifyPendingIntrosActionNeeded(
  memberId: string,
  activeBatchId: string | null,
  cycleKey: string,
): Promise<{ handled: boolean; emailed: boolean; skipped: boolean; alreadyHandled: boolean; error?: string }> {
  try {
    const admin = createAdminClient()
    const dedupeKey = `actionneeded:${cycleKey}`
    // 1. Durable check — was this member already handled for this weekly cycle?
    const { data: existing } = await admin
      .from('notifications').select('id')
      .eq('user_id', memberId).eq('type', 'introductions_waiting').eq('data->>dedupeKey', dedupeKey).limit(1)
    if (existing && existing.length > 0) {
      return { handled: true, emailed: false, skipped: false, alreadyHandled: true }
    }

    // 2. Send the email.
    const { data: p } = await admin.from('profiles').select('email, full_name').eq('id', memberId).maybeSingle()
    let emailed = false, skipped = false, error: string | undefined
    if (p?.email && process.env.RESEND_API_KEY) {
      console.log('[Email] type=intro_action_needed')
      const { sendPendingIntrosReminderEmail } = await import('@/lib/email')
      const res = await sendPendingIntrosReminderEmail(p.email, p.full_name || 'there')
      emailed = res.success; skipped = !!res.skipped; error = res.error
      if (!res.success && !res.skipped) {
        // Hard send failure → record NOTHING so a retry can re-send. Reported separately.
        return { handled: false, emailed: false, skipped: false, alreadyHandled: false, error }
      }
    }
    // 3. Record the durable cycle marker + in-app notification (email sent / suppressed / no address).
    await createNotificationSafe({
      userId: memberId,
      type: 'introductions_waiting',
      data: { batchId: activeBatchId, dedupeKey },
      dedupeKey,
    })
    return { handled: true, emailed, skipped, alreadyHandled: false }
  } catch (e: any) {
    console.error('[engagement] notifyPendingIntrosActionNeeded failed (non-fatal):', e?.message)
    return { handled: false, emailed: false, skipped: false, alreadyHandled: false, error: e?.message || String(e) }
  }
}
