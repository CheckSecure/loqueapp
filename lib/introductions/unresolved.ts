/**
 * THE shared meaning of "this member has an introduction they have not answered".
 *
 * public.count_unresolved_introductions() (migration 081) is the AUTHORITY — it is what actually
 * refuses a placement, under the member advisory locks, where two concurrent writers cannot both
 * win. This module is its mirror, for the two places that only need to read the same answer: the
 * Introductions-page notice and the weekly prefilter that avoids issuing pointless RPC calls.
 *
 * Keeping them in step is a test obligation, not a hope: the PostgreSQL harness runs the same case
 * table against the SQL function that lib/__tests__ runs against this one.
 *
 * ─── WHAT COUNTS ──────────────────────────────────────────────────────────────────────────────
 * A live 'suggested' card the member has not answered AND can actually answer.
 *
 * ─── WHAT DOES NOT, AND WHY ───────────────────────────────────────────────────────────────────
 *   hasOwnExpression      the member answered — a correlated expression (responds_to_id, 080) and a
 *                         legacy pending/approved row are the same fact here, so 080's correlation
 *                         and the pre-080 semantics are preserved by one test rather than two.
 *   capacity-released     a released waiting card is STILL 'suggested' after 72 hours, but its
 *                         author expressed interest, so hasOwnExpression is true and it is already
 *                         excluded. There is deliberately no separate rule for it: if the expression
 *                         were ever withdrawn the card becomes answerable again and SHOULD count.
 *   queued                not 'suggested'. Invisible, so there is nothing to answer yet.
 *   passed/expired/etc.   no longer 'suggested'.
 *   targetActive false    the member CANNOT act on it. Counting it would block them permanently
 *                         through no fault of their own — the trap the audit found.
 *   targetExpressedAtMe   this is incoming interest. It is answered from "Interested in you", it
 *                         does not control weekly eligibility by product rule, and decline-incoming
 *                         does not clear the outbound 'suggested' row — so counting it would be a
 *                         second permanent trap.
 *   targetMatched         already connected; nothing left to answer.
 */

/** Statuses that mean the member has already answered a recommendation for that target. */
export const ANSWERED_STATUSES = [
  'pending', 'approved', 'accepted', 'accepted_pending_payment', 'admin_pending',
] as const

export interface UnresolvedCandidate {
  /** intro_requests.status of the recommendation row. */
  status: string
  /** The member has a live outbound expression toward this target (correlated or legacy). */
  hasOwnExpression: boolean
  /** The target is still an active member. */
  targetActive: boolean
  /** An active match already exists between the two. */
  targetMatched: boolean
  /** The target has expressed interest AT this member (incoming interest). */
  targetExpressedAtMember: boolean
}

/** One row's verdict. Mirrors the SQL predicate clause for clause. */
export function isUnresolvedIntroduction(row: UnresolvedCandidate): boolean {
  if (row.status !== 'suggested') return false
  if (row.hasOwnExpression) return false
  if (!row.targetActive) return false
  if (row.targetMatched) return false
  if (row.targetExpressedAtMember) return false
  return true
}

export function countUnresolvedIntroductions(rows: UnresolvedCandidate[] | null | undefined): number {
  return (rows ?? []).filter(isUnresolvedIntroduction).length
}

export function hasUnresolvedIntroductions(rows: UnresolvedCandidate[] | null | undefined): boolean {
  return countUnresolvedIntroductions(rows) > 0
}

/**
 * Whether the Introductions page shows the "respond to stay eligible" notice.
 *
 * It takes the page's ALREADY-DERIVED actionable suggestions — the same array that renders the
 * cards — so the notice can never disagree with what the member is looking at. That is the whole
 * point: a notice telling someone to act on cards that are not on screen is worse than no notice.
 *
 * The page's derivation has already removed correlated waiting entries, capacity-released rows,
 * queued rows, terminal rows, matched and deactivated targets, and incoming-interest targets, so
 * every exclusion above is honoured by construction rather than re-implemented here.
 */
export function shouldShowRespondNotice(actionableSuggestions: unknown[] | null | undefined): boolean {
  return (actionableSuggestions?.length ?? 0) > 0
}
