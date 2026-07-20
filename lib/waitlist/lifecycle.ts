import { normalizeEmail } from '@/lib/auth/normalizeEmail'
import { isValidEmail } from '@/lib/firstMatchingReminder/eligibility'

/**
 * Canonical invited-user activation-email lifecycle.
 *
 * The state is COMPUTED from durable timestamps + profile completion — there is
 * no separate lifecycle status column to keep in sync. "Completed" is the same
 * canonical signal used by Admin → Waitlist → Invited (profiles.profile_complete
 * = true, matched by normalized email — see lib/waitlist/joined.ts).
 *
 * The one-time July campaign (first_matching_reminder_sent_at) is intentionally
 * NOT part of the sequence: it is surfaced only as `receivedFirstMatching` and
 * never counts as reminder 1 or 2, never advances or blocks the sequence, and
 * never disqualifies a genuinely new invitee.
 */

/**
 * Reminder schedule — the single source of truth for timing. The existing cron
 * sends reminder 1 ~1 day after invite and reminder 2 at 7 days; these mirror
 * that intended cadence. Change here to reschedule everywhere.
 */
export const REMINDER_SCHEDULE = {
  reminder1DelayHours: 24,   // reminder 1 becomes due 1 day after invited_at
  reminder2DelayHours: 168,  // reminder 2 becomes due 7 days after invited_at (and only after reminder 1)
} as const

export type LifecycleState =
  | 'completed'            // profile_complete → no further activation email
  | 'not_invited'          // status !== 'invited' (defensive)
  | 'invalid_email'        // blank/malformed email
  | 'missing_invited_at'   // invited but invited_at is null (data anomaly)
  | 'invite_sent'          // invited, reminder 1 not yet due
  | 'reminder_1_due'       // reminder 1 is due and unsent
  | 'reminder_1_sent'      // reminder 1 sent, reminder 2 not yet due
  | 'reminder_2_due'       // reminder 2 is due and unsent (reminder 1 already sent)
  | 'reminder_2_sent'      // full sequence complete

export type LifecycleInput = {
  status: string
  email: string | null
  invited_at: string | null
  invite_reminder_1_sent_at: string | null
  invite_reminder_2_sent_at: string | null
  first_matching_reminder_sent_at: string | null
  /** profiles.profile_complete for the matching (normalized-email) profile. */
  profileComplete: boolean
}

export type LifecycleResult = {
  state: LifecycleState
  lastEmail: 'invite' | 'reminder_1' | 'reminder_2' | null
  lastEmailAt: string | null
  nextEmail: 'reminder_1' | 'reminder_2' | null
  nextDueAt: string | null
  /** True only when an activation email is due AND allowed right now. */
  canSendActivationEmail: boolean
  /** Informational: received the one-time July first-matching campaign. */
  receivedFirstMatching: boolean
  /** Why no activation email can be sent right now (null when one can). */
  excludedReason: string | null
}

const HOUR_MS = 60 * 60 * 1000

function addHours(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * HOUR_MS).toISOString()
}

/**
 * Compute the lifecycle for one invited row. `nowMs` is injected for
 * deterministic testing (callers pass Date.now()).
 */
export function computeLifecycle(input: LifecycleInput, nowMs: number): LifecycleResult {
  const r1 = input.invite_reminder_1_sent_at
  const r2 = input.invite_reminder_2_sent_at
  const receivedFirstMatching = !!input.first_matching_reminder_sent_at

  const lastEmail: LifecycleResult['lastEmail'] = r2 ? 'reminder_2' : r1 ? 'reminder_1' : input.invited_at ? 'invite' : null
  const lastEmailAt = r2 ?? r1 ?? input.invited_at ?? null

  const base = { lastEmail, lastEmailAt, receivedFirstMatching }

  // 1. Completion halts the sequence regardless of timestamps.
  if (input.profileComplete) {
    return { ...base, state: 'completed', nextEmail: null, nextDueAt: null, canSendActivationEmail: false, excludedReason: 'completed' }
  }
  // 2. Defensive gates.
  if (input.status !== 'invited') {
    return { ...base, state: 'not_invited', nextEmail: null, nextDueAt: null, canSendActivationEmail: false, excludedReason: 'not_invited' }
  }
  const email = normalizeEmail(input.email)
  if (!email || !isValidEmail(email)) {
    return { ...base, state: 'invalid_email', nextEmail: null, nextDueAt: null, canSendActivationEmail: false, excludedReason: 'invalid_email' }
  }
  if (!input.invited_at) {
    return { ...base, state: 'missing_invited_at', nextEmail: null, nextDueAt: null, canSendActivationEmail: false, excludedReason: 'missing_invited_at' }
  }

  const r1DueAt = addHours(input.invited_at, REMINDER_SCHEDULE.reminder1DelayHours)
  const r2DueAt = addHours(input.invited_at, REMINDER_SCHEDULE.reminder2DelayHours)

  // 3. Sequence complete.
  if (r2) {
    return { ...base, state: 'reminder_2_sent', nextEmail: null, nextDueAt: null, canSendActivationEmail: false, excludedReason: 'sequence_complete' }
  }
  // 4. Reminder 1 already sent → reminder 2 track.
  if (r1) {
    const due = nowMs >= new Date(r2DueAt).getTime()
    return {
      ...base,
      state: due ? 'reminder_2_due' : 'reminder_1_sent',
      nextEmail: 'reminder_2',
      nextDueAt: r2DueAt,
      canSendActivationEmail: due,
      excludedReason: due ? null : 'reminder_2_not_due',
    }
  }
  // 5. No reminders yet → reminder 1 track.
  const due = nowMs >= new Date(r1DueAt).getTime()
  return {
    ...base,
    state: due ? 'reminder_1_due' : 'invite_sent',
    nextEmail: 'reminder_1',
    nextDueAt: r1DueAt,
    canSendActivationEmail: due,
    excludedReason: due ? null : 'reminder_1_not_due',
  }
}

/**
 * "Newly invited / no follow-up sent": invited, incomplete, has invited_at, and
 * neither reminder sent. The July campaign does NOT disqualify (it is not part
 * of the follow-up sequence).
 */
export function isNewlyInvitedNoFollowup(input: LifecycleInput): boolean {
  return (
    input.status === 'invited' &&
    !input.profileComplete &&
    !!input.invited_at &&
    !input.invite_reminder_1_sent_at &&
    !input.invite_reminder_2_sent_at
  )
}

/** Short human label for the admin "Email lifecycle" column. */
export function lifecycleLabel(state: LifecycleState): string {
  switch (state) {
    case 'completed': return 'Completed'
    case 'not_invited': return 'Not invited'
    case 'invalid_email': return 'Invalid email'
    case 'missing_invited_at': return 'Missing invite date'
    case 'invite_sent': return 'Invite sent'
    case 'reminder_1_due': return 'Reminder 1 due'
    case 'reminder_1_sent': return 'Reminder 1 sent'
    case 'reminder_2_due': return 'Reminder 2 due'
    case 'reminder_2_sent': return 'Sequence complete'
  }
}
