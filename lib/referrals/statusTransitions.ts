/**
 * Server-side guard for the nomination (waitlist) recommendation lifecycle.
 *
 * The admin UI already prevents invalid transitions by tab-gating the buttons;
 * this makes the API enforce the same rules so a direct/stale/duplicate call can't
 * move a row backward or sideways. This mirrors the UI — it does NOT change the
 * workflow.
 *
 * Lifecycle: pending → approved → contacted → invited → (activated, tracked on
 * referrals/profiles during onboarding — not a waitlist.status value, so it is not
 * modeled here). Notes:
 *   • contacted → contacted is allowed (resend the warm recommendation email).
 *   • invited → invited is allowed (resend access email / password reset).
 *   • declined → invited is the ONLY move out of declined: an admin "Reinstate" to
 *     correct an accidental decline. It flips the status marker back to invited (no email,
 *     no provisioning); declined → approved/contacted/revoked stays disallowed.
 *   • revoked is terminal.
 */
export const WAITLIST_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ['approved', 'declined'],
  approved: ['contacted', 'invited', 'declined'],
  contacted: ['contacted', 'invited', 'declined'],
  invited: ['invited', 'revoked'],
  declined: ['invited'], // Reinstate — undo an accidental decline (back to the Invited tab)
  revoked: [], // terminal — a revoked invitation cannot be re-invited or re-declined
}

export function canTransition(from: string | null | undefined, to: string): boolean {
  const allowed = WAITLIST_TRANSITIONS[(from || '').trim()] ?? null
  return allowed ? allowed.includes(to) : false
}

/**
 * Route-level guard: block a transition ONLY when the source is a KNOWN status
 * that does not permit the target. An unknown / null / legacy status is NOT
 * blocked (permissive) so this can never break inviting a pre-existing row whose
 * status was never set. Enforces the real invalid transitions (e.g. pending→invited,
 * declined→approved, invited→contacted) without over-reaching.
 */
export function isBlockedTransition(from: string | null | undefined, to: string): boolean {
  const known = WAITLIST_TRANSITIONS[(from || '').trim()]
  if (!known) return false // unknown / legacy / null → do not block
  return !known.includes(to)
}

/** Human-readable reason for a rejected transition (used in the 409 body). */
export function invalidTransitionMessage(from: string | null | undefined, to: string): string {
  return `Cannot move this nomination from "${from || 'unknown'}" to "${to}". Refresh the page — its status may have changed.`
}
