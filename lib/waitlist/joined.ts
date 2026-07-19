import { normalizeEmail } from '@/lib/auth/normalizeEmail'

/**
 * "Joined" = the invited person has completed onboarding, which is the canonical
 * signal `profiles.profile_complete = true` (written only by the onboarding
 * completion paths). Mere login is NOT enough — someone who signs in but
 * abandons onboarding has profile_complete=false and must stay in Invited.
 *
 * waitlist.email == profiles.email by construction (the invite/onboarding
 * upsert keys on email), so we match the two by normalized email.
 */
export type WaitlistRowLike = { status: string; email: string | null }

/** An 'invited' waitlist row whose person has already completed onboarding. */
export function isInvitedButJoined(
  row: WaitlistRowLike,
  completedEmails: Set<string>,
): boolean {
  return (
    row.status === 'invited' &&
    !!row.email &&
    completedEmails.has(normalizeEmail(row.email))
  )
}

/**
 * Remove people who have already joined from the Invited view without touching
 * any other tab or mutating any record. Rows that are 'invited' but whose owner
 * completed onboarding are dropped; everything else passes through unchanged.
 */
export function excludeJoinedFromInvited<T extends WaitlistRowLike>(
  rows: T[],
  completedEmails: Set<string>,
): T[] {
  return rows.filter(row => !isInvitedButJoined(row, completedEmails))
}

/** Build the normalized completed-email set from profile rows. */
export function toCompletedEmailSet(
  profiles: Array<{ email: string | null }> | null | undefined,
): Set<string> {
  return new Set((profiles ?? []).map(p => normalizeEmail(p.email)).filter(Boolean))
}
