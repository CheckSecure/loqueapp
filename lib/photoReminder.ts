/**
 * Escalating dismissal logic for the profile-photo reminder.
 *
 * Reuses the app's localStorage banner-dismissal pattern (like PageHint /
 * FoundingMemberWelcomeBanner / ProfileCompletionCard), but stores a small JSON
 * value under one versioned key so the reminder can snooze for increasing
 * windows instead of a single boolean:
 *
 *   1st "Maybe later" → hide 21 days
 *   2nd "Maybe later" → hide 45 days
 *   3rd "Maybe later" → hide permanently
 *
 * Pure functions (state + `now` in, decision out) so the timing is unit-tested
 * without a browser. No DB, no schema change, per-device only — consistent with
 * the other dashboard nudge cards.
 */

export const PHOTO_REMINDER_KEY = 'andrel:photo-reminder:v1'

const DAY_MS = 24 * 60 * 60 * 1000

/** Snooze window (in days) applied on the Nth "Maybe later". 3rd+ → permanent. */
export const SNOOZE_DAYS: Record<number, number> = { 1: 21, 2: 45 }

/** After this many dismissals the reminder is hidden permanently (no photo). */
export const MAX_DISMISSALS = 3

export interface PhotoReminderState {
  /** How many times "Maybe later" has been chosen. */
  count: number
  /** Epoch ms before which the reminder stays hidden; null = no time-based hide. */
  hiddenUntil: number | null
}

/** Parse the stored value defensively; returns null for absent/invalid data. */
export function parseState(raw: string | null | undefined): PhotoReminderState | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.count !== 'number') return null
    return {
      count: parsed.count,
      hiddenUntil: typeof parsed.hiddenUntil === 'number' ? parsed.hiddenUntil : null,
    }
  } catch {
    return null
  }
}

/**
 * Whether to show the reminder right now.
 * - Never when a photo exists (suppressed permanently by an upload).
 * - Shown when never dismissed.
 * - Hidden permanently after MAX_DISMISSALS.
 * - Otherwise hidden until `hiddenUntil`.
 */
export function shouldShowPhotoReminder(
  hasPhoto: boolean,
  state: PhotoReminderState | null,
  now: number,
): boolean {
  if (hasPhoto) return false
  if (!state) return true
  if (state.count >= MAX_DISMISSALS) return false
  if (state.hiddenUntil != null && now < state.hiddenUntil) return false
  return true
}

/** Compute the next dismissal state when the user clicks "Maybe later". */
export function nextDismissState(state: PhotoReminderState | null, now: number): PhotoReminderState {
  const count = (state?.count ?? 0) + 1
  const days = SNOOZE_DAYS[count]
  const hiddenUntil = days != null ? now + days * DAY_MS : null // 3rd+ → permanent via count
  return { count, hiddenUntil }
}
