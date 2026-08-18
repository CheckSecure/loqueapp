/**
 * The three ways a member can dismiss an introduction card, and what each one means.
 *
 * Two things are recorded for every dismissal, and they answer different questions:
 *
 *   status            — the LIFECYCLE question: is this card still live, and may the pair ever be
 *                       recommended again? This is what the matcher reads.
 *   resolution_reason — the INTENT question: why did the member dismiss it? Analytics only; the
 *                       matcher never reads it.
 *
 * Keeping them separate is what makes the three choices distinguishable after the fact. Before the
 * reason column existed, "Not for me" and "Don't show again" collapsed into their statuses and
 * "already know them" was indistinguishable from a rejected fit.
 *
 * IMPORTANT — 'already_know' is NOT a quality signal. It records that the two people already have
 * a relationship, so an introduction would be redundant. Nothing may treat it as a block, a
 * complaint, or evidence that either member is a poor match.
 */

export const DISMISS_CHOICES = ['not_for_me', 'never_show', 'already_know'] as const
export type DismissChoice = (typeof DISMISS_CHOICES)[number]

export function isDismissChoice(value: unknown): value is DismissChoice {
  return typeof value === 'string' && (DISMISS_CHOICES as readonly string[]).includes(value)
}

/**
 * The status a dismissed NON-reciprocal card resolves to.
 *
 *   not_for_me    → 'passed'            SOFT history. Deliberately unchanged: today "Not for me"
 *                                       is releasable by the exhaustion safety valve, and this
 *                                       change must not silently make it permanent.
 *   never_show    → 'hidden_permanent'  HARD history — unchanged existing behaviour.
 *   already_know  → 'hidden_permanent'  HARD history, so the pair is never recommended again in
 *                                       EITHER direction (classifyIntroHistory is bidirectional
 *                                       and the valve never releases HARD).
 *
 * Both terminal choices reuse an EXISTING status on purpose: no new status value means no change
 * to intro_requests_status_check, to the matcher, or to create_reciprocal_suggestion's status
 * list. The distinct meaning is carried by the reason, not by inventing a state.
 */
export function statusForDismissal(choice: DismissChoice): 'passed' | 'hidden_permanent' {
  return choice === 'not_for_me' ? 'passed' : 'hidden_permanent'
}

/** True when the choice must permanently exclude the pair from all future matching. */
export function isPermanentDismissal(choice: DismissChoice): boolean {
  return statusForDismissal(choice) === 'hidden_permanent'
}
