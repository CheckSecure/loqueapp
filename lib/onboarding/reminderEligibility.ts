/**
 * THE onboarding-reminder eligibility contract. Pure, unit-tested, and the single place the rule
 * lives — the cron, the admin catch-up campaign and the audit all read the same predicate.
 *
 * ─── WHAT WAS WRONG BEFORE ────────────────────────────────────────────────────────────────────
 * The previous rule disqualified anyone whose auth user had `last_sign_in_at` set: "once a user
 * signs in, they're permanently disqualified". Signing in is not finishing. Production shows 18
 * people who signed in, stalled mid-onboarding, and could never be reminded again — the exact
 * cohort a reminder exists for. Eligibility now ends at COMPLETION, never at sign-in.
 *
 * The old stage 1 also used a 23–48h WINDOW and stage 2 required stage 1 to have been sent. A single
 * missed cron run aged a person past the window, which made stage 1 unreachable, which made stage 2
 * unreachable. Stages are now FLOORS: "at least 24h", "at least 3 days", "at least 7 days". A missed
 * day delays a reminder; it can no longer strand anyone.
 */

export const STAGE_PURPOSES = [
  'onboarding_reminder_1',
  'onboarding_reminder_2',
  'onboarding_reminder_3',
] as const
export type StagePurpose = (typeof STAGE_PURPOSES)[number]

/** Floors, in hours. Deliberately floors and not windows — see above. */
export const STAGE_FLOORS_HOURS: Record<StagePurpose, number> = {
  onboarding_reminder_1: 24,
  onboarding_reminder_2: 24 * 3,
  onboarding_reminder_3: 24 * 7,
}

/** Do not nudge someone who was working on their profile moments ago. */
export const RECENT_ACTIVITY_QUIET_HOURS = 24

export interface ReminderCandidate {
  /** waitlist row id — the dedupe key alongside the stage purpose. */
  waitlistId: string
  /** NULL until migration 077's invite path stamps it. NULL ⇒ historical ⇒ never automatic. */
  reminderEnrollmentAt: string | null
  invitedAt: string | null
  waitlistStatus: string | null
  /** auth users at this normalized address. Anything but exactly 1 is unsafe. */
  authUserCount: number
  /**
   * auth.users.last_sign_in_at for the resolved unique identity, or null.
   *
   * Used ONLY by the catch-up predicate. It is deliberately NOT part of automatic eligibility:
   * disqualifying on sign-in is the original defect, and the automatic sequence must reach people
   * who were invited and never came back. The approved historical cohort, by contrast, is defined
   * as people who DID sign in and stalled — so the catch-up predicate requires it.
   */
  lastSignInAt?: string | null
  /**
   * The resolved unique auth uuid, present only when authUserCount === 1. Carried on the candidate
   * so callers never re-resolve it (a second lookup is a second chance to disagree) and so a
   * resume token can be bound to the identity that was actually evaluated.
   */
  authUserIdResolved?: string | null
  accountStatus?: string | null
  profileExists: boolean
  profileComplete: boolean | null
  /** profiles.updated_at — the quiet-hours signal. */
  profileUpdatedAt?: string | null
  isAdmin?: boolean | null
  isTestAccount?: boolean | null
  /** provider suppression at this address (bounced / blocked / complained). */
  suppressed: boolean
  /** stage purposes already claimed for this waitlist row. */
  stagesAlreadyClaimed: readonly string[]
  /** explicit testing allowlist — the ONLY way an admin/test account receives one. */
  allowlistedForTesting?: boolean
}

export type CatchupExclusion =
  | 'never_signed_in' | 'prospectively_enrolled' | 'not_invited_status' | 'completed'
  | 'ambiguous_identity' | 'suppressed' | 'deactivated' | 'admin_or_test'

export type IneligibleReason =
  | 'not_enrolled'          // historical invitation — never automatic
  | 'no_invited_at'
  | 'not_invited_status'
  | 'revoked_or_declined'
  | 'completed'
  | 'deactivated'
  | 'ambiguous_identity'
  | 'suppressed'
  | 'admin_or_test'
  | 'recent_activity'
  | 'all_stages_sent'
  | 'too_early'

export type EligibilityResult =
  | { eligible: true; stage: StagePurpose }
  | { eligible: false; reason: IneligibleReason }

const hoursSince = (iso: string, nowMs: number) => (nowMs - Date.parse(iso)) / 3_600_000

/**
 * Decide whether this candidate should receive an automatic reminder right now, and which stage.
 *
 * Order matters: the terminal and unsafe reasons are evaluated BEFORE the timing ones, so a
 * completed or revoked person is reported as such rather than as "too early".
 */
export function evaluateReminder(c: ReminderCandidate, nowMs: number): EligibilityResult {
  // PROSPECTIVE ONLY. This single check is what keeps the 117 historical invitees out of every
  // automatic send. It is first because nothing else about them matters.
  if (!c.reminderEnrollmentAt) return { eligible: false, reason: 'not_enrolled' }

  if (c.waitlistStatus === 'revoked' || c.waitlistStatus === 'declined') {
    return { eligible: false, reason: 'revoked_or_declined' }
  }
  if (c.waitlistStatus !== 'invited') return { eligible: false, reason: 'not_invited_status' }

  // TERMINAL. Completion — never sign-in — ends the sequence.
  if (c.profileComplete === true) return { eligible: false, reason: 'completed' }

  if (c.accountStatus && c.accountStatus !== 'active') return { eligible: false, reason: 'deactivated' }
  if (c.authUserCount !== 1) return { eligible: false, reason: 'ambiguous_identity' }
  if (c.suppressed) return { eligible: false, reason: 'suppressed' }

  if ((c.isAdmin === true || c.isTestAccount === true) && !c.allowlistedForTesting) {
    return { eligible: false, reason: 'admin_or_test' }
  }

  if (!c.invitedAt) return { eligible: false, reason: 'no_invited_at' }

  // Someone actively editing their profile does not need an email about it.
  if (c.profileUpdatedAt && hoursSince(c.profileUpdatedAt, nowMs) < RECENT_ACTIVITY_QUIET_HOURS) {
    return { eligible: false, reason: 'recent_activity' }
  }

  const age = hoursSince(c.invitedAt, nowMs)
  const claimed = new Set(c.stagesAlreadyClaimed)

  // FLOORS, and the FIRST unsent stage whose floor has passed. A person who is 10 days old and has
  // had nothing sent gets stage 1, not stage 3: the sequence is still a sequence, it just cannot be
  // skipped past by the calendar. That is what makes a missed run recoverable instead of fatal.
  for (const stage of STAGE_PURPOSES) {
    if (claimed.has(stage)) continue
    if (age >= STAGE_FLOORS_HOURS[stage]) return { eligible: true, stage }
    return { eligible: false, reason: 'too_early' }
  }
  return { eligible: false, reason: 'all_stages_sent' }
}

/**
 * The historical catch-up cohort: SIGNED IN AT LEAST ONCE, still incomplete, and NOT enrolled for
 * automatic reminders.
 *
 * The sign-in requirement is the whole point of this cohort and was missing. Without it the
 * predicate matched essentially the entire historical population — the 117 — rather than the ~18
 * people who actually started and stalled. Those are very different sends: one is a nudge to
 * someone mid-task, the other is a cold re-approach to people who never engaged at all, which was
 * explicitly not approved.
 *
 * Deliberately a separate predicate from evaluateReminder: this population is reached only by an
 * explicit admin action, never by the cron.
 */
export function classifyCatchup(c: ReminderCandidate): 'ready' | CatchupExclusion {
  if (c.reminderEnrollmentAt) return 'prospectively_enrolled'   // the cron owns these
  if (c.waitlistStatus !== 'invited') return 'not_invited_status'
  if (c.profileComplete === true) return 'completed'
  if (c.authUserCount !== 1) return 'ambiguous_identity'
  // THE COHORT DEFINITION. Someone who never signed in is not "stalled mid-onboarding"; they never
  // began. Reported as its own classification so a dry run makes the distinction visible.
  if (!c.lastSignInAt) return 'never_signed_in'
  if (c.suppressed) return 'suppressed'
  if (c.accountStatus && c.accountStatus !== 'active') return 'deactivated'
  if (c.isAdmin === true || c.isTestAccount === true) return 'admin_or_test'
  return 'ready'
}

/** Convenience wrapper. Prefer classifyCatchup(), which says WHY. */
export function isCatchupCandidate(c: ReminderCandidate): boolean {
  return classifyCatchup(c) === 'ready'
}
