import { normalizeEmail } from '@/lib/auth/normalizeEmail'

/**
 * One-time "first matching round" reminder campaign.
 *
 * Recipient cohort == Admin → Waitlist → Invited, i.e. people who are currently
 * waitlist.status='invited' and have NOT completed onboarding. "Completed" is
 * the SAME canonical signal used by the Invited tab (profiles.profile_complete
 * = true, matched by normalized email — see lib/waitlist/joined.ts), so this can
 * never drift from that definition.
 *
 * Idempotency: a recipient is skipped once waitlist.first_matching_reminder_sent_at
 * is set, so a retry (or an accidental second trigger) never re-sends.
 */
export const CAMPAIGN_ID = 'first-matching-round-reminder-2026-07-21'

export type ReminderWaitlistRow = {
  id: string
  email: string | null
  full_name: string | null
  status: string
  first_matching_reminder_sent_at: string | null
}

export type Recipient = { id: string; email: string; firstName: string }

export type CohortResult = {
  recipients: Recipient[]
  stats: {
    rawInvited: number
    excludedCompleted: number
    excludedInvalidEmail: number
    excludedAlreadySent: number
    removedDuplicates: number
    finalCount: number
  }
}

/** Conservative, dependency-free email shape check. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

/**
 * Safe first name for greeting. Returns the first whitespace-delimited token of
 * the full name, or "there" when no usable name exists — so a blank or malformed
 * value can never render as "Hi ,".
 */
export function firstNameOrThere(fullName: string | null | undefined): string {
  const first = (fullName ?? '').trim().split(/\s+/)[0] ?? ''
  return first.length >= 1 ? first : 'there'
}

/**
 * Pure cohort selection. Given the invited waitlist rows and the set of
 * normalized emails that have completed onboarding, returns the deduplicated
 * recipient list plus a breakdown of every exclusion (for the dry run).
 */
export function selectReminderCohort(
  rows: ReminderWaitlistRow[],
  completedEmails: Set<string>,
): CohortResult {
  const stats = {
    rawInvited: 0,
    excludedCompleted: 0,
    excludedInvalidEmail: 0,
    excludedAlreadySent: 0,
    removedDuplicates: 0,
    finalCount: 0,
  }
  const seen = new Set<string>()
  const recipients: Recipient[] = []

  for (const row of rows) {
    if (row.status !== 'invited') continue // defensive — caller queries invited only
    stats.rawInvited++

    const email = normalizeEmail(row.email)
    if (!email || !isValidEmail(email)) { stats.excludedInvalidEmail++; continue }
    if (completedEmails.has(email)) { stats.excludedCompleted++; continue }
    if (row.first_matching_reminder_sent_at) { stats.excludedAlreadySent++; continue }
    if (seen.has(email)) { stats.removedDuplicates++; continue }

    seen.add(email)
    recipients.push({ id: row.id, email, firstName: firstNameOrThere(row.full_name) })
  }

  stats.finalCount = recipients.length
  return { recipients, stats }
}
