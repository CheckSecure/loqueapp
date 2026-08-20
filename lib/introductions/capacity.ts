/**
 * THE authoritative introduction-capacity contract.
 *
 * There are TWO independent tiers, and they must never be described or counted as one combined cap
 * again — conflating them is what produced the production defect this file exists to end:
 *
 *   VISIBLE  (status 'suggested')  at most 2. What the member can actually see and act on.
 *   RESERVED (status 'queued')     at most 2. Generated and held back; not yet shown to anyone.
 *
 * A reciprocal pair card and a legacy batch card are the SAME thing for capacity purposes. Capacity
 * is decided by `status` alone — never by whether `batch_id` or `pair_id` happens to be populated.
 * The defect: batch placement decided occupancy from the existence of a recommendation_batches row,
 * so a member holding only a reciprocal card (which has no batch row) looked empty and received two
 * more visible cards on top of it — three visible, of which the UI silently showed two.
 *
 * A reserved card does NOT block a visible one. A member with zero visible and two queued may still
 * receive a reciprocal introduction into a visible slot; the reservations stay reserved and a later
 * promotion then sees only one remaining visible slot.
 *
 * UI SLICING IS NOT ENFORCEMENT. app/dashboard/introductions renders at most two cards, which hides
 * over-capacity rather than preventing it — and it hides the OLDEST row, which is typically the
 * reciprocal card, quietly breaking the two-sided guarantee. Enforcement belongs to the database
 * RPCs, under the member advisory lock.
 */

/** Statuses that occupy a capacity tier. Everything else is terminal and frees the slot. */
export const VISIBLE_STATUS = 'suggested' as const
export const RESERVED_STATUS = 'queued' as const

export const MAX_VISIBLE_INTRO_CARDS = 2
export const MAX_RESERVED_INTRO_CARDS = 2

export interface CardCounts {
  /** status = 'suggested' — cards the member can see right now. */
  visible: number
  /** status = 'queued' — generated, reserved, not yet shown. */
  reserved: number
}

/** Free visible slots. Reserved cards never consume a visible slot. */
export function visibleSlotsFree(counts: CardCounts): number {
  return Math.max(0, MAX_VISIBLE_INTRO_CARDS - Math.max(0, counts.visible))
}

/** Free reserved slots. Visible cards never consume a reserved slot. */
export function reservedSlotsFree(counts: CardCounts): number {
  return Math.max(0, MAX_RESERVED_INTRO_CARDS - Math.max(0, counts.reserved))
}

/** True when the member can accept another VISIBLE card (the reciprocal-creation question). */
export function hasVisibleCapacity(counts: CardCounts): boolean {
  return visibleSlotsFree(counts) > 0
}

// ── Fairness exposure ───────────────────────────────────────────────────────────────────────────
//
// Exposure answers "how often is this candidate being SHOWN to other people", so it is keyed on
// target_user_id. Visible and reserved are kept as SEPARATE signals: a queued reservation has not
// been presented to anyone yet, so treating it exactly like a card already on someone's screen
// over-penalises it. Measured on production, one combined number pushed 59% of candidates onto just
// three distinct penalty levels — the penalty saturated and stopped discriminating at all, which is
// the concentration problem the penalty exists to prevent. Separate caps keep eight levels.

export const VISIBLE_PENALTY_PER_CARD = 2
export const VISIBLE_PENALTY_CAP = 6
export const RESERVED_PENALTY_PER_CARD = 1
export const RESERVED_PENALTY_CAP = 2
/** The most exposure can ever shave off a compatibility score. */
export const MAX_EXPOSURE_PENALTY = VISIBLE_PENALTY_CAP + RESERVED_PENALTY_CAP // 8

/**
 * Bounded exposure penalty in fit points. Bounded on BOTH tiers so a materially better-matched
 * candidate can still win: the ceiling is 8, well under a meaningful compatibility gap.
 */
export function exposurePenalty(counts: CardCounts): number {
  const visible = Math.min(VISIBLE_PENALTY_CAP, Math.max(0, counts.visible) * VISIBLE_PENALTY_PER_CARD)
  const reserved = Math.min(RESERVED_PENALTY_CAP, Math.max(0, counts.reserved) * RESERVED_PENALTY_PER_CARD)
  return visible + reserved
}

/** Zero-exposure default, so a candidate absent from the map is never treated as undefined. */
export const NO_EXPOSURE: CardCounts = { visible: 0, reserved: 0 }
