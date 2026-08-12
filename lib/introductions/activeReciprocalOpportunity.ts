/**
 * The shared "does this member CURRENTLY have a usable / ongoing reciprocal opportunity" predicate.
 *
 * `member_pairs` is a PERMANENT audit record — a historical expired/passed/blocked pair row does NOT
 * prove the member currently has a member-facing opportunity. A retry job may complete only when the
 * member no longer needs a NEW onboarding recommendation, proven from CURRENT state.
 *
 * A member has an active reciprocal OPPORTUNITY iff EITHER:
 *   1. their OWN reciprocal intro_requests row is in an allowed active status
 *      (requester_id = userId, pair_id IS NOT NULL, status ∈ ACTIVE_RECIPROCAL_STATUSES); OR
 *   2. they are connected through a reciprocal pair (member_pairs.status = 'matched').
 *
 * FALSE (→ fail closed → retry) for: only the counterpart's row; a passed/expired/hidden/declined/
 * rejected row; a legacy (pair_id NULL) row; or any partial/inconsistent state.
 */

/**
 * Statuses a member's OWN reciprocal (pair_id) row can legitimately hold that prove an active/ongoing
 * opportunity. Only two occur for pair_id rows:
 *   • 'suggested' — the reciprocal recommendation card is currently RENDERED (a usable card).
 *   • 'approved'  — the member EXPRESSED interest on their reciprocal card (express-interest /
 *                   accept-incoming write 'approved'); the engagement is live, awaiting mutual /
 *                   already matched — they do not need a new onboarding card.
 * DELIBERATELY EXCLUDED because they never occur for pair_id rows (the reciprocal RPC inserts
 * 'suggested', and member action writes 'approved'): 'queued'/'pending' (legacy batch / one-sided
 * statuses) and 'accepted'/'accepted_pending_payment' (never written for pair rows; the latter was a
 * removed legacy admin credit-hold). Terminal-negative statuses (passed/expired/hidden/declined/
 * rejected) are excluded because they mean the member DOES need a new recommendation.
 */
export const ACTIVE_RECIPROCAL_STATUSES = ['suggested', 'approved'] as const

/** Pure row test — the member's OWN active reciprocal row (guards against counterpart rows, legacy
 *  pair_id-NULL rows, and terminal/non-active statuses). A 'suggested' row is a rendered card; an
 *  'approved' row is an ongoing engagement — NOT described as a card. */
export function isActiveReciprocalOpportunityRow(
  row: { requester_id: string; pair_id: string | null; status: string },
  userId: string,
): boolean {
  return row.requester_id === userId
    && row.pair_id != null
    && (ACTIVE_RECIPROCAL_STATUSES as readonly string[]).includes(row.status)
}

/**
 * IO: does the member currently have an active reciprocal opportunity (own live row) OR a matched
 * reciprocal pair? Read-only; two bounded lookups; fail-closed on absence.
 */
export async function hasActiveReciprocalOpportunity(admin: any, userId: string): Promise<boolean> {
  // (1) The member's OWN active reciprocal row (rendered card or live engagement).
  const { data: rows } = await admin
    .from('intro_requests')
    .select('status')
    .eq('requester_id', userId)
    .not('pair_id', 'is', null)
    .in('status', ACTIVE_RECIPROCAL_STATUSES as unknown as string[])
    .limit(1)
  if (rows && rows.length > 0) return true

  // (2) Already connected through a reciprocal pair (no new card needed).
  const { data: matched } = await admin
    .from('member_pairs')
    .select('id')
    .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)
    .eq('status', 'matched')
    .limit(1)
  return !!(matched && matched.length > 0)
}
