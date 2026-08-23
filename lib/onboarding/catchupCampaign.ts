/**
 * Historical onboarding catch-up campaign identity.
 *
 * FIXED AND DOCUMENTED, never generated. A key derived from a timestamp or a request id would make
 * every rerun a new campaign, so the durable per-recipient dedupe would let the same person be
 * emailed again on every click. A constant makes a rerun idempotent by definition.
 *
 * It lives here rather than in the route because a Next.js route module may only export handlers
 * and a small set of route options — exporting anything else fails the build.
 */
export const CATCHUP_CAMPAIGN_KEY = 'onboarding-catchup-2026-08'
