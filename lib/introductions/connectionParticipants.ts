/**
 * Recipient-relative participant resolution for a newly created connection.
 *
 * ─── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 * A connection has two members and produces two notifications and two emails. Each one must carry
 * the OTHER member's identity, and "the other member" is only meaningful relative to who is
 * receiving it. `matches.user_a_id` / `user_b_id` are storage positions with no such meaning — the
 * table's own contract is that they are interchangeable — so any code that treats one column as
 * "the counterpart" is right for one recipient and wrong for the other. That is a defect that
 * cannot be caught by testing a single direction, because a single direction always looks correct.
 *
 * This module removes the possibility rather than documenting the rule. Callers do not pick a
 * counterpart; they ask for the fan-out and get both directions already paired, built from the two
 * member ids they passed in and never from row order.
 *
 * ─── THE SELF-PAIRING GUARD IS THE POINT ──────────────────────────────────────────────────────
 * `recipient.id === counterpart.id` would tell a member they are now connected with themselves.
 * It is returned as an empty fan-out instead: nothing is sent, which is the only safe answer.
 */

/** The profile fields a connection notification or email needs. Nothing private beyond the email. */
export interface ConnectionParticipant {
  id: string
  full_name: string | null
  email: string | null
  title: string | null
  company: string | null
}

/** One outbound direction: who receives it, and who it is about. */
export interface ConnectionDirection {
  recipient: ConnectionParticipant
  counterpart: ConnectionParticipant
}

/** Columns to request from readProfilesByIds so the shape above is satisfied exactly. */
export const CONNECTION_PARTICIPANT_COLUMNS = 'id, full_name, email, title, company'

/**
 * Build BOTH outbound directions for a connection between two members.
 *
 * @param memberOneId  one participant — position carries no meaning
 * @param memberTwoId  the other participant — position carries no meaning
 * @param profiles     rows for (at least) those two ids, in any order
 *
 * Returns `[]` when either profile is missing or the two ids are the same, so a caller that
 * iterates the result sends nothing rather than sending something wrong. Order of the returned
 * array follows (memberOne, memberTwo) purely for deterministic tests; no caller may depend on it
 * to decide identity, because each element already carries its own recipient and counterpart.
 */
export function connectionDirections(
  memberOneId: string,
  memberTwoId: string,
  profiles: readonly ConnectionParticipant[] | null | undefined,
): ConnectionDirection[] {
  if (!memberOneId || !memberTwoId) return []
  // A member is never their own counterpart. Refusing here is what makes "you are connected with
  // yourself" unrepresentable rather than merely unlikely.
  if (memberOneId === memberTwoId) return []

  const byId = new Map<string, ConnectionParticipant>()
  for (const p of profiles ?? []) if (p?.id) byId.set(p.id, p)

  const one = byId.get(memberOneId)
  const two = byId.get(memberTwoId)
  // Partial data is not a licence to send half a fan-out with a missing name. Either both members
  // are resolvable or this connection notifies nobody and the caller logs it.
  if (!one || !two) return []

  return [
    { recipient: one, counterpart: two },
    { recipient: two, counterpart: one },
  ]
}

/** Display name for a counterpart, with the same fallback the email helper already used. */
export function counterpartDisplayName(counterpart: ConnectionParticipant): string {
  return (counterpart.full_name ?? '').trim() || 'Your connection'
}
