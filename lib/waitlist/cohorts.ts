import { normalizeEmail } from '@/lib/auth/normalizeEmail'
import { firstNameOrThere } from '@/lib/firstMatchingReminder/eligibility'
import {
  computeLifecycle,
  isNewlyInvitedNoFollowup,
  type LifecycleInput,
  type LifecycleState,
} from '@/lib/waitlist/lifecycle'

/**
 * Reusable, side-effect-free cohort selectors for the activation-email
 * lifecycle. Every selector derives state from the shared lifecycle module
 * (no independent definitions), normalizes + de-duplicates emails, excludes
 * completed profiles, invalid emails, already-sent recipients (encoded in the
 * lifecycle state), and any provided suppressions. They return counts + a
 * recipient list keyed by id/email — callers must never log the addresses.
 */

export type WaitlistLifecycleRow = {
  id: string
  email: string | null
  full_name: string | null
  status: string
  invited_at: string | null
  invite_reminder_1_sent_at: string | null
  invite_reminder_2_sent_at: string | null
  first_matching_reminder_sent_at: string | null
}

export type CohortRecipient = {
  id: string
  email: string
  firstName: string
  state: LifecycleState
  nextDueAt: string | null
}

export type CohortStats = {
  scanned: number
  excludedCompleted: number
  excludedInvalidEmail: number
  excludedNotDueOrWrongState: number
  excludedSuppressed: number
  removedDuplicates: number
  finalCount: number
}

export type CohortResult = { recipients: CohortRecipient[]; stats: CohortStats }

type Options = {
  completedEmails: Set<string>
  nowMs: number
  /** Normalized emails to treat as suppressed (bounced/opted-out). Optional. */
  suppressedEmails?: Set<string>
}

/**
 * Generic engine: keep a row when `predicate(lifecycle, input)` is true, after
 * the universal exclusions (completed / invalid / suppressed / duplicate).
 */
function selectCohort(
  rows: WaitlistLifecycleRow[],
  opts: Options,
  predicate: (lc: ReturnType<typeof computeLifecycle>, input: LifecycleInput) => boolean,
): CohortResult {
  const suppressed = opts.suppressedEmails ?? new Set<string>()
  const stats: CohortStats = {
    scanned: 0, excludedCompleted: 0, excludedInvalidEmail: 0,
    excludedNotDueOrWrongState: 0, excludedSuppressed: 0, removedDuplicates: 0, finalCount: 0,
  }
  const seen = new Set<string>()
  const recipients: CohortRecipient[] = []

  for (const row of rows) {
    stats.scanned++
    const email = normalizeEmail(row.email)
    const input: LifecycleInput = {
      status: row.status,
      email: row.email,
      invited_at: row.invited_at,
      invite_reminder_1_sent_at: row.invite_reminder_1_sent_at,
      invite_reminder_2_sent_at: row.invite_reminder_2_sent_at,
      first_matching_reminder_sent_at: row.first_matching_reminder_sent_at,
      profileComplete: !!email && opts.completedEmails.has(email),
    }
    const lc = computeLifecycle(input, opts.nowMs)

    if (lc.state === 'completed') { stats.excludedCompleted++; continue }
    if (lc.state === 'invalid_email' || !email) { stats.excludedInvalidEmail++; continue }
    if (!predicate(lc, input)) { stats.excludedNotDueOrWrongState++; continue }
    if (suppressed.has(email)) { stats.excludedSuppressed++; continue }
    if (seen.has(email)) { stats.removedDuplicates++; continue }

    seen.add(email)
    recipients.push({ id: row.id, email, firstName: firstNameOrThere(row.full_name), state: lc.state, nextDueAt: lc.nextDueAt })
  }
  stats.finalCount = recipients.length
  return { recipients, stats }
}

/** Users for whom reminder 1 is due right now. */
export function reminder1DueCohort(rows: WaitlistLifecycleRow[], opts: Options): CohortResult {
  return selectCohort(rows, opts, lc => lc.state === 'reminder_1_due')
}

/** Users for whom reminder 2 is due right now (reminder 1 already sent). */
export function reminder2DueCohort(rows: WaitlistLifecycleRow[], opts: Options): CohortResult {
  return selectCohort(rows, opts, lc => lc.state === 'reminder_2_due')
}

/** Newly invited, incomplete, no follow-up reminder sent yet (July does not disqualify). */
export function newlyInvitedNoFollowupCohort(rows: WaitlistLifecycleRow[], opts: Options): CohortResult {
  return selectCohort(rows, opts, (_lc, input) => isNewlyInvitedNoFollowup(input))
}

/** True for the five genuine invited-sequence states (excludes not_invited / missing_invited_at). */
const SEQUENCE_STATES = new Set<LifecycleState>([
  'invite_sent', 'reminder_1_due', 'reminder_1_sent', 'reminder_2_due', 'reminder_2_sent',
])

/** Incomplete invited users who DID receive the one-time July first-matching campaign. */
export function incompleteReceivedFirstMatchingCohort(rows: WaitlistLifecycleRow[], opts: Options): CohortResult {
  return selectCohort(rows, opts, lc => SEQUENCE_STATES.has(lc.state) && lc.receivedFirstMatching)
}

/** Incomplete invited users who did NOT receive the July first-matching campaign. */
export function incompleteNotReceivedFirstMatchingCohort(rows: WaitlistLifecycleRow[], opts: Options): CohortResult {
  return selectCohort(rows, opts, lc => SEQUENCE_STATES.has(lc.state) && !lc.receivedFirstMatching)
}
