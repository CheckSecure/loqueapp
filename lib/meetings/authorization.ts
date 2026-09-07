/**
 * Server-side authorization for CREATING a meeting request.
 *
 * ─── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 * `scheduleMeeting` (app/actions.ts) read `recipient_id` straight out of the submitted FormData and
 * inserted the meeting with the SERVICE-ROLE client — which bypasses RLS — without ever checking
 * that the two members had any relationship. The Schedule modal only offers matched members, so the
 * product looked correct; the server accepted any UUID. A forged form post therefore produced a
 * `meetings` row, a `notifications` row, and an email carrying the requester's real name, to a
 * member who had never been introduced to them. The Meetings page then hydrated that counterpart's
 * name/title/company/avatar through service_role, so the row also became a profile-disclosure
 * channel in both directions. A UI picker is not an authorization boundary.
 *
 * ─── THE RULE, AND WHY IT IS THIS RULE ────────────────────────────────────────────────────────
 * A meeting is the in-person continuation of a conversation, so the gate is deliberately the SAME
 * one `lib/messages/sendMessageCore.ts` already applies to sending a message — a non-removed match,
 * no block in either direction, both parties active. Reusing that rule set rather than inventing a
 * second one means the two surfaces cannot drift into disagreeing about who may contact whom, which
 * is exactly how this gap appeared in the first place.
 *
 * Everything is decided here, in code, against a service-role client. That is intentional and is
 * the established pattern in this codebase (see sendMessageCore): the browser role's DML on
 * `meetings` is revoked (migration 055), so the write must run as service_role, and a check that
 * runs as service_role cannot lean on RLS. It also means this gate holds regardless of what RLS
 * policies `meetings` does or does not carry — which matters, because that live state is not
 * currently reproducible from the migration files.
 *
 * ─── FAIL CLOSED ──────────────────────────────────────────────────────────────────────────────
 * Any query error returns `false`. An uncertain answer is a refusal, never an authorization.
 */

import { buildBidirectionalMatchFilter, buildBidirectionalBlockFilter } from '@/lib/db/filters'
import { isMemberProfileId } from '@/lib/profiles/profileHref'

/**
 * ONE opaque refusal for every failure mode — no such member, never matched, match removed,
 * blocked, deactivated, or a database error. The caller must not be usable as an oracle for
 * whether a given UUID belongs to a real member, so the message is identical in all cases and
 * mentions nothing the requester did not already supply.
 */
export const MEETING_NOT_AVAILABLE = 'This member is not available for scheduling.'

/** Match statuses that do NOT permit contact. Mirrors sendMessageCore exactly. */
const CLOSED_MATCH_STATUSES = new Set(['removed', 'closed'])

/**
 * Per-member daily cap on OUTBOUND meeting requests. A meeting request emails the recipient, so an
 * unbounded loop over even legitimately-matched members is a spam vector. Sized well above real
 * usage (a member has at most a handful of connections) so it never touches normal behaviour.
 *
 * Lives here rather than in app/actions.ts because that file carries `'use server'`, which permits
 * only async function exports — an exported const there is a build error.
 */
export const MEETING_REQUESTS_PER_DAY = 10

/**
 * May `requesterId` create a meeting request naming `recipientId`?
 *
 * @param admin  MUST be a service-role client — the relationship lookups must not themselves be
 *               RLS-filtered, or a missing policy would silently turn a real relationship into a
 *               refusal (and a permissive one into a false grant).
 */
export async function canRequestMeetingWith(
  admin: { from: (t: string) => any },
  requesterId: string,
  recipientId: string,
): Promise<boolean> {
  if (!requesterId || !recipientId) return false
  if (requesterId === recipientId) return false

  // SHAPE BEFORE USE. Both ids are interpolated into PostgREST `.or()` filter strings below, and
  // `recipientId` arrives from submitted form data. A value carrying `,` or `)` could otherwise
  // restructure the filter expression. Today a malformed value fails the uuid cast and the query
  // error already fails us closed — but relying on a downstream cast error for a structural
  // guarantee is the kind of reasoning that stops holding the moment a column type or a filter
  // helper changes. Rejecting anything that is not a UUID removes the class outright, and costs one
  // regex. The refusal is the same opaque one as every other failure, so this is not an oracle for
  // "is that a well-formed id".
  if (!isMemberProfileId(requesterId) || !isMemberProfileId(recipientId)) return false

  try {
    const [matchRes, blockRes, partiesRes] = await Promise.all([
      admin
        .from('matches')
        .select('id, status')
        .or(buildBidirectionalMatchFilter(requesterId, recipientId)),
      admin
        .from('blocked_users')
        .select('id')
        .or(buildBidirectionalBlockFilter(requesterId, recipientId))
        .limit(1),
      admin
        .from('profiles')
        .select('id, account_status')
        .in('id', [requesterId, recipientId]),
    ])

    // Any error → fail closed. An unreadable graph is not permission.
    if (matchRes.error || blockRes.error || partiesRes.error) return false

    // A live match in either direction. `status` is checked in code rather than in the query so a
    // future status value is treated as unknown-and-therefore-open only if it is genuinely not a
    // closed one — the closed set is explicit and small.
    const hasLiveMatch = (matchRes.data ?? []).some(
      (m: { status: string | null }) => !CLOSED_MATCH_STATUSES.has(String(m?.status ?? '')),
    )
    if (!hasLiveMatch) return false

    if ((blockRes.data ?? []).length > 0) return false

    // Both parties must still be active. A deactivated member neither sends nor receives.
    const parties = partiesRes.data ?? []
    const requester = parties.find((p: { id: string }) => p.id === requesterId)
    const recipient = parties.find((p: { id: string }) => p.id === recipientId)
    if (!requester || !recipient) return false
    if (requester.account_status !== 'active') return false
    if (recipient.account_status !== 'active') return false

    return true
  } catch {
    return false
  }
}
