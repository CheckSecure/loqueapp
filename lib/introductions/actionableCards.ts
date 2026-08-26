/**
 * THE canonical definition of "an introduction card this member can act on right now".
 *
 * WHY THIS MODULE EXISTS. Three places needed the same answer and each had its own version:
 * the Introductions page derived it inline while rendering, lib/introductions/unresolved.ts
 * mirrored the SQL predicate for the weekly prefilter, and public.count_unresolved_introductions()
 * (migration 081) is the authority that actually refuses a placement. Guidance copy that counts
 * cards MUST count the same cards the member is looking at — a banner saying "2 waiting" above one
 * clickable card is worse than no banner — so the page's derivation now lives here, is pure, and is
 * tested against the same case table as the SQL predicate.
 *
 * ─── THE PREDICATE ────────────────────────────────────────────────────────────────────────────
 * A card is ACTIONABLE when every one of these holds:
 *   1. it is the signed-in member's OWN outbound row          (requester_id = me — enforced by the query)
 *   2. status = 'suggested'                                    (the only member-actionable state)
 *   3. its target profile actually loaded                      (orphaned / malformed rows excluded)
 *   4. the target's account_status = 'active'
 *   5. no active match already exists with that target
 *   6. the member has no live outbound expression toward them  (they already answered)
 *   7. the target has not expressed interest AT the member     (that is answered from "Interested in you")
 *
 * ─── WHAT IS EXCLUDED, AND WHY IT IS EXCLUDED HERE RATHER THAN LATER ──────────────────────────
 *   queued              not 'suggested' — reserved, never rendered, nothing to answer yet.
 *   expired / passed /  terminal statuses; the row is no longer 'suggested'.
 *   hidden_permanent
 *   archived
 *   already answered    a correlated expression (responds_to_id, 080) or a legacy pending/approved
 *                       row are the same fact: the member responded.
 *   capacity-released   still 'suggested' after 72h, but its author expressed interest, so rule 6
 *                       already excludes it. There is deliberately no separate rule: if the
 *                       expression were withdrawn the card becomes answerable again and SHOULD count.
 *   inactive target     the member CANNOT act on it.
 *   matched target      already connected; nothing left to answer.
 *   incoming interest   answered from "Interested in you"; declining there does not clear the
 *                       outbound 'suggested' row, so counting it here would trap the member.
 *   malformed/orphaned  no joined target profile.
 *
 * ─── UNAVAILABLE TARGETS (migration 085) ──────────────────────────────────────────────────────
 * A card whose target is missing, inactive, profile-incomplete, a test account, matching-paused, or
 * blocked in EITHER direction is not actionable and is excluded here — and, since 085, is excluded
 * by public.count_unresolved_introductions() too. Both halves matter and neither is safe alone:
 *   hide it but keep counting it  -> the member is blocked with nothing on screen to click
 *   count it but keep showing it  -> the member is asked to answer someone they cannot, or must
 *                                    not, be shown (blocking)
 * The two predicates are therefore written to agree clause for clause, and a test asserts the SQL
 * body names every field this module tests.
 *
 * ─── RAW ROWS vs USABLE CARDS ─────────────────────────────────────────────────────────────────
 * The database now draws the same distinction this module always has, and uses the same words:
 *   RAW     every placement row still 'suggested'. May exceed the visible cap while stale
 *           unavailable rows await maintenance. A historical artifact, never an allocation.
 *   USABLE  the same, minus unavailable targets — public.count_usable_visible_cards(). What the
 *           member can see and answer, what placement is bounded by, and what this module returns.
 * Every user-facing count on the page is USABLE. Nothing renders or counts a raw stale row.
 *
 * ─── NO DISPLAY CAP ───────────────────────────────────────────────────────────────────────────
 * The visible-card cap governs CREATION, in the database writers, under the member advisory locks.
 * It is NOT a display rule and this module does not apply one. Slicing the actionable list would
 * hide a card the strict gate still counts, so the member would be told to respond to everything
 * and then be unable to reach the card that is holding them. Every genuinely actionable card is
 * returned and rendered, however many there are. An over-capacity member is a real operational
 * signal — see overCapacityWarning() — not something to paper over on screen.
 */

/** The only member-actionable card status. */
export const ACTIONABLE_CARD_STATUS = 'suggested' as const

/** Statuses that mean the member has already answered a recommendation for that target. */
export const ANSWERED_OUTBOUND_STATUSES = [
  'pending', 'approved', 'accepted', 'accepted_pending_payment', 'admin_pending',
] as const

/** A raw `intro_requests` row joined to its target profile, as the page reads it. */
export interface SuggestedCardRow {
  id: string
  target_user_id: string
  /** Joined target profile; absent/null for an orphaned or malformed row. */
  target?: { id: string; account_status?: string | null } | null
  status?: string | null
  pair_id?: string | null
  match_reason?: string | null
  created_at?: string | null
}

/** Everything the predicate needs about the member's other state, resolved once by the caller. */
export interface ActionableContext {
  /** Target ids the member already has an active match with. */
  matchedTargetIds: ReadonlySet<string>
  /**
   * Target ids the member cannot, or must not, be asked to answer: missing, inactive,
   * profile-incomplete, test-only, matching-paused, or blocked in either direction. Resolved by the
   * caller from the SAME facts public.count_unresolved_introductions() reads (migration 085).
   */
  unavailableTargetIds: ReadonlySet<string>
  /** Target ids who have expressed interest AT this member (incoming interest). */
  incomingInterestTargetIds: ReadonlySet<string>
  /** Target ids the member already answered — live outbound expression, correlated or legacy. */
  answeredTargetIds: ReadonlySet<string>
}

/** One row's verdict. Every clause is a rule from the header; nothing is implicit. */
export function isActionableCard(row: SuggestedCardRow | null | undefined, ctx: ActionableContext): boolean {
  if (!row) return false
  // 3 — orphaned / malformed: no joined target, or a target with no id.
  const target = row.target
  if (!target || !target.id) return false
  // 2 — the status is carried by the query for the page, but a caller may pass unfiltered rows.
  if (row.status != null && row.status !== ACTIONABLE_CARD_STATUS) return false
  const id = target.id
  // 4 — UNAVAILABLE target. Checked from BOTH the joined column and the caller's set: the page
  // resolves availability in a separate service-role read and the join may not carry those fields.
  if (target.account_status != null && target.account_status !== 'active') return false
  if (ctx.unavailableTargetIds.has(id)) return false
  // 5, 7, 6
  if (ctx.matchedTargetIds.has(id)) return false
  if (ctx.incomingInterestTargetIds.has(id)) return false
  if (ctx.answeredTargetIds.has(id)) return false
  return true
}

/**
 * EVERY actionable card the member has, deduplicated by target. There is no cap and no slice.
 *
 * Dedup-by-target is part of the predicate, not a display nicety: two 'suggested' rows for the same
 * person are ONE thing to answer, and answering either resolves both. Counting rows would overstate
 * what the member has to do.
 *
 * The returned array is exactly what the page renders, which is what makes a count derived from it
 * honest by construction — and, because nothing is dropped, what makes "respond to these and you
 * are clear" a promise the member can actually keep.
 */
export function selectActionableCards<T extends SuggestedCardRow>(
  rows: readonly T[] | null | undefined,
  ctx: ActionableContext,
): T[] {
  const byTarget = new Map<string, T>()
  for (const row of rows ?? []) {
    if (!isActionableCard(row, ctx)) continue
    const id = row.target!.id
    if (!byTarget.has(id)) byTarget.set(id, row)
  }
  return Array.from(byTarget.values())
}

/**
 * A member holding more actionable cards than the visible cap is an operational fact worth knowing:
 * every writer refuses to exceed it, so it means a historical row, a manual intervention, or a bug.
 *
 * It is reported to the SERVER LOG and never to the member. There is nothing for them to do about
 * it, the cards all work, and a technical warning on the Introductions page would frighten someone
 * whose only task is to answer three cards instead of two. Returns null when there is nothing to
 * report, so the caller cannot accidentally log an empty warning.
 */
export function overCapacityWarning(actionableCount: number, visibleCap: number): string | null {
  const n = Math.max(0, actionableCount | 0)
  if (n <= visibleCap) return null
  return `[introductions] member holds ${n} actionable cards, above the visible cap of ${visibleCap}. `
    + 'All are rendered so they can be answered; none is hidden. Investigate placement — no writer '
    + 'should be able to exceed the cap.'
}

/** How many introductions are awaiting this member's response. Always === rendered card count. */
export function countActionableCards(actionable: readonly unknown[] | null | undefined): number {
  return actionable?.length ?? 0
}
