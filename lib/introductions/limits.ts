import { MAX_VISIBLE_INTRO_CARDS, MAX_RESERVED_INTRO_CARDS } from '@/lib/introductions/capacity'

/**
 * RECOMMENDATIONS_PER_BATCH — how many recommendations a member receives per release.
 *
 * IT IS NOT A CAP, AND IT IS NOT THE COMBINED CAP. Capacity lives in
 * lib/introductions/capacity, which defines TWO independent tiers — at most
 * MAX_VISIBLE_INTRO_CARDS ('suggested') and, separately, at most
 * MAX_RESERVED_INTRO_CARDS ('queued'). This constant is the RELEASE SIZE, and it is
 * derived from the visible cap because a release must never be larger than the number
 * of visible slots it is trying to fill. Describing suggested+queued as a single cap of
 * 2 is what allowed members to end up holding three visible cards.
 *
 * This is the RECURRING release size: each weekly release delivers a batch of this
 * size (only once the previous batch is complete). The FIRST release is different —
 * see ONBOARDING_RECOMMENDATIONS below. Every recurring path — the weekly release,
 * replenishment, the admin reciprocal batch, UI counts, and batch-completion logic
 * — references this single constant, so it can be raised to 3 later without
 * redesigning the workflow.
 */
export const RECOMMENDATIONS_PER_BATCH = MAX_VISIBLE_INTRO_CARDS

/**
 * ONBOARDING_RECOMMENDATIONS — how many recommendations a member receives in their
 * FIRST release, at signup.
 *
 * IT IS NOT A CAP EITHER. It is deliberately SMALLER than RECOMMENDATIONS_PER_BATCH so a
 * brand-new member meets one person rather than two at once; the visible ceiling stays
 * MAX_VISIBLE_INTRO_CARDS, so the Thursday admin batch — which fills
 * visibleDeficit(visible, MAX_VISIBLE_INTRO_CARDS) — tops the member up to two.
 *
 * This is why it is a SEPARATE constant and not a smaller RECOMMENDATIONS_PER_BATCH:
 * RECOMMENDATIONS_PER_BATCH is derived from the visible cap, so lowering it to 1 would
 * silently lower the ceiling to 1 and there would be nothing to top up TO.
 *
 * The onboarding RETRY worker delivers the same first release, so it targets this
 * constant too — a member whose first generation failed must not end up with more cards
 * than a member whose first generation succeeded.
 */
export const ONBOARDING_RECOMMENDATIONS = 1

/**
 * @deprecated Use MAX_VISIBLE_INTRO_CARDS from lib/introductions/capacity for a capacity
 * decision, or RECOMMENDATIONS_PER_BATCH for a release size. The old name reads like a
 * single combined cap, which is exactly the confusion this file no longer perpetuates.
 */
export const ACTIVE_INTRO_CAP = RECOMMENDATIONS_PER_BATCH

/**
 * Recommendations delivered per release for a given tier. Every tier currently
 * returns RECOMMENDATIONS_PER_BATCH; the tier parameter is accepted (and ignored)
 * so per-tier sizing can be reintroduced in exactly one place without touching any
 * call site.
 */
export function getActiveIntroCap(_tier?: string): number {
  return RECOMMENDATIONS_PER_BATCH
}

/**
 * Re-exported so a caller reaching for "the cap" lands on the two-tier contract rather than on the
 * release size. A capacity decision must import these, never RECOMMENDATIONS_PER_BATCH.
 */
export { MAX_VISIBLE_INTRO_CARDS, MAX_RESERVED_INTRO_CARDS }
