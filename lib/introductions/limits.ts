/**
 * RECOMMENDATIONS_PER_BATCH — the ONE configurable value for how many
 * recommendations a member receives per release.
 *
 * A member experiences a single curated recommendation cycle: onboarding delivers
 * the first batch of this size, and each weekly release delivers another batch of
 * this size (only once the previous batch is complete). There is no separate
 * "onboarding" vs "recurring" limit. Every path — onboarding, the weekly release,
 * replenishment, the admin reciprocal batch, UI counts, and batch-completion logic
 * — references this single constant, so it can be raised to 3 later without
 * redesigning the workflow.
 */
export const RECOMMENDATIONS_PER_BATCH = 2

/**
 * @deprecated Use RECOMMENDATIONS_PER_BATCH. Retained as an alias so existing
 * importers keep resolving to the single source of truth.
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
