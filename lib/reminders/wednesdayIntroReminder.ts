/**
 * WEDNESDAY UNANSWERED-INTRODUCTION REMINDER — pure logic.
 *
 * WHAT WAS BROKEN. The existing reminder (engagement-reminders PART 3) keys on an ACTIVE
 * recommendation_batches envelope and dedupes on `introreminder:<batch_id>`. Three consequences,
 * all measured in the production audit:
 *   1. create_reciprocal_suggestion leaves batch_id NULL and creates NO envelope, so every
 *      onboarding/weekly reciprocal card is structurally unreachable — those members are never
 *      reminded at all.
 *   2. Migration 064 REUSES a live admin envelope across review cycles, so the one dedupe key is
 *      already spent: a second card added later gets no reminder.
 *   3. The reminder fires at most once per envelope, ever.
 *
 * This module keys on the CARD, not on any envelope, and on the member + ISO week, not on a batch.
 * It touches no batch table at all.
 *
 * Everything here is pure and synchronous so it can be tested without a database, a clock, or a
 * mail provider.
 */

/** A member's unanswered visible card, reduced to what eligibility actually needs. */
export interface OpenCard {
  requesterId: string
  targetUserId: string
  /** intro_requests.status — only 'suggested' is an open, unanswered card. */
  status: string
  /** NULL for legacy/admin one-sided rows; set for reciprocal pairs. Both qualify. */
  pairId: string | null
}

export interface ReminderProfile {
  id: string
  email: string | null
  firstName: string | null
  accountStatus: string | null
  profileComplete: boolean | null
  isTestAccount: boolean | null
  isAdmin: boolean | null
  matchingPaused: boolean | null
}

/**
 * Statuses that mean the member ALREADY RESPONDED to that target, so the card is not open.
 * `pending` and the other expressed-interest states are responses — a member whose only unresolved
 * state is a pending interest of their own must NOT be reminded to respond.
 */
export const RESPONDED_STATUSES: ReadonlySet<string> = new Set([
  'pending', 'accepted', 'accepted_pending_payment', 'admin_pending', 'approved',
  'passed', 'declined', 'rejected', 'hidden', 'hidden_permanent', 'expired', 'archived',
])

/**
 * Statuses an unanswered-introduction scan must READ: open cards plus every status that counts as a
 * RESPONSE. Both the weekly cron and the one-time catch-up campaign use this one list, so they can
 * never drift into disagreeing about who has an open card.
 */
export const REMINDER_RELEVANT_STATUSES = [
  'suggested', 'pending', 'accepted', 'accepted_pending_payment', 'admin_pending', 'approved',
  'passed', 'declined', 'rejected', 'hidden', 'hidden_permanent', 'expired', 'archived',
]

/** True when this row is an open, unanswered visible card. */
export function isOpenCard(row: { status: string }): boolean {
  return row.status === 'suggested'
}

/**
 * A member's OPEN cards: 'suggested' rows for which they have no responding row toward the same
 * target. Mirrors countUnresolvedRecommendations in lib/introductions/queue.ts, so the reminder and
 * the product agree on what "unanswered" means.
 */
export function openCardsFor(memberId: string, rows: readonly OpenCard[]): OpenCard[] {
  const responded = new Set<string>()
  for (const r of rows) {
    if (r.requesterId !== memberId) continue
    if (RESPONDED_STATUSES.has(r.status)) responded.add(r.targetUserId)
  }
  return rows.filter((r) =>
    r.requesterId === memberId && isOpenCard(r) && !responded.has(r.targetUserId))
}

export type IneligibleReason =
  | 'inactive' | 'incomplete_profile' | 'test_account' | 'admin_account'
  | 'matching_paused' | 'no_email' | 'no_open_cards'

/** Why a member does NOT qualify, or null when they do. Reasons are aggregate-safe labels. */
export function reminderIneligibility(
  p: ReminderProfile,
  openCardCount: number,
): IneligibleReason | null {
  if (p.accountStatus !== 'active') return 'inactive'
  if (!p.profileComplete) return 'incomplete_profile'
  if (p.isTestAccount) return 'test_account'
  if (p.isAdmin) return 'admin_account'
  if (p.matchingPaused) return 'matching_paused'
  if (!p.email || !p.email.includes('@')) return 'no_email'
  if (openCardCount < 1) return 'no_open_cards'
  return null
}

// ── Scheduling ──────────────────────────────────────────────────────────────────────────────────

export const REMINDER_TIMEZONE = 'America/New_York'

/**
 * The calendar parts of an instant IN NEW YORK. Uses Intl, which carries the full IANA rule set, so
 * EST/EDT and the transition weekends are handled by the platform rather than by an offset guess.
 * A UTC weekday would diverge from New York's for five hours every day (four in DST) — long enough
 * to send on the wrong calendar day.
 */
export function newYorkParts(now: Date): { weekday: string; year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: REMINDER_TIMEZONE,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]))
  return {
    weekday: String(parts.weekday),
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
  }
}

/** True only on a Wednesday in America/New_York, DST included. */
export function isWednesdayInNewYork(now: Date): boolean {
  return newYorkParts(now).weekday === 'Wed'
}

/**
 * ISO-week key derived from the NEW YORK calendar date, not from UTC. Computing it from UTC could
 * place a late-evening New York Wednesday into the following week's key and permit a second send.
 * A Wednesday is mid-week, so it is never near an ISO week boundary once the date is correct.
 */
export function newYorkIsoWeekKey(now: Date): string {
  const { year, month, day } = newYorkParts(now)
  const dt = new Date(Date.UTC(year, month - 1, day))
  const dow = dt.getUTCDay() || 7
  dt.setUTCDate(dt.getUTCDate() + 4 - dow)
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((dt.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** The durable dedupe identity: one consolidated reminder per member per ISO week. */
export const REMINDER_PURPOSE = 'wednesday_intro_reminder' as const

// ── Copy ────────────────────────────────────────────────────────────────────────────────────────

/** The canonical Introductions page. www is the canonical host (rel=canonical, apex -> www). */
export const INTRODUCTIONS_URL = 'https://www.andrel.app/dashboard/introductions'

export interface ReminderCopy { subject: string; greeting: string; countLine: string; body: string; cta: string; closing: string[] }

/**
 * Deliberately says nothing about the other person: not their name, employer, whether they
 * responded, or whether they expressed interest. It also never promises a Thursday introduction —
 * it states only that the next batch is PREPARED Thursday and that unanswered cards occupy slots.
 */
export function wednesdayReminderCopy(firstName: string | null, openCount: number): ReminderCopy {
  const name = (firstName || '').trim() || 'there'
  const countLine = openCount === 1
    ? 'You currently have one introduction awaiting your response in Andrel.'
    : `You currently have ${openCount} introductions awaiting your response in Andrel.`
  return {
    subject: 'Please review your Andrel introductions before Thursday',
    greeting: `Hi ${name},`,
    countLine,
    body: 'The next curated introduction batch is prepared Thursday. Please review your current '
        + 'introductions and choose whether you would like to connect. Unanswered introductions '
        + 'occupy your available introduction slots and may limit your eligibility for future batches.',
    cta: 'Review introductions',
    closing: ['Best,', 'Daniel', 'Founder, Andrel'],
  }
}
