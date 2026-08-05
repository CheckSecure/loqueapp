// Shared server-side discoverability rule.
//
// Andrel is a curated-introduction network, NOT a directory. A member may discover
// another member's identity ONLY when: it's themselves, they're connected, they
// were actually shown that member through a valid introduction/recommendation, or
// the member has live approved incoming interest directed at them. Blocked pairs
// are always denied. This is the ONE definition used by every server surface; never
// rely on client-side hiding.
//
// Enforcement uses a service-role client (bypasses RLS) so the decision is made
// here, deterministically, before any profile data is returned.

import { buildBidirectionalMatchFilter } from '@/lib/db/filters'

/**
 * intro_request statuses that grant HISTORICAL discoverability — i.e. rows that
 * were actually surfaced to the viewer. `queued` is intentionally excluded: a
 * queued row sits behind the active batch and has never been shown.
 */
export const DISCOVERY_GRANT_STATUSES: readonly string[] = [
  'suggested',
  'pending',
  'approved',
  'accepted',
  'accepted_pending_payment',
  'admin_pending',
  'passed',
  'hidden',
  'hidden_permanent',
  'declined',
  'rejected',
  'expired',
  'archived',
]
const GRANT = new Set(DISCOVERY_GRANT_STATUSES)

/** Live incoming-interest status (member expressed interest AT the viewer). */
const INCOMING_INTEREST_STATUS = 'approved'

export interface IntroRow {
  requester_id: string
  target_user_id: string
  status: string
  is_admin_initiated: boolean | null
}

/**
 * Pure direction-aware decision over the relationship rows. Exported for direct
 * unit testing; the DB wrapper below feeds it real rows.
 *
 * - viewer === member → true (self)
 * - blocked pair → false
 * - active (non-removed) match → true
 * - intro_requests:
 *     • admin-initiated (mutual) row with a surfaced status → true
 *     • member-initiated requester=viewer,target=member with a surfaced status
 *       (the viewer was SHOWN the member) → true
 *     • member-initiated requester=member,target=viewer ONLY when status='approved'
 *       (live incoming interest the viewer can act on) → true
 *     • anything else (incl. `queued`, or "I was shown to them") → no grant
 * Uncertainty → false.
 */
export function decideDiscoverability(args: {
  viewerId: string
  memberId: string
  isBlocked: boolean
  hasActiveMatch: boolean
  introRows: IntroRow[]
}): boolean {
  const { viewerId, memberId, isBlocked, hasActiveMatch, introRows } = args
  if (!viewerId || !memberId) return false
  if (viewerId === memberId) return true
  if (isBlocked) return false
  if (hasActiveMatch) return true

  for (const r of introRows ?? []) {
    const admin = r.is_admin_initiated === true
    const viewerToMember = r.requester_id === viewerId && r.target_user_id === memberId
    const memberToViewer = r.requester_id === memberId && r.target_user_id === viewerId
    if (admin) {
      // Admin intros write a row in EACH direction and expose both parties.
      if ((viewerToMember || memberToViewer) && GRANT.has(r.status)) return true
    } else if (viewerToMember) {
      // The viewer was shown this member (their own suggestion/intro of the member).
      if (GRANT.has(r.status)) return true
    } else if (memberToViewer) {
      // "I was shown to them" grants nothing UNLESS it's live incoming interest.
      if (r.status === INCOMING_INTEREST_STATUS) return true
    }
  }
  return false
}

/**
 * Server-side authority: may `viewerId` discover `memberId`? `db` MUST be a
 * service-role client so the relationship lookups aren't themselves RLS-filtered.
 * Returns false on any query error (fail-closed).
 */
export async function canViewerDiscoverMember(
  db: { from: (t: string) => any },
  viewerId: string,
  memberId: string,
): Promise<boolean> {
  if (!viewerId || !memberId) return false
  if (viewerId === memberId) return true

  try {
    const [blockRes, matchRes, introRes] = await Promise.all([
      db.from('blocked_users')
        .select('user_id, blocked_user_id')
        .or(`and(user_id.eq.${viewerId},blocked_user_id.eq.${memberId}),and(user_id.eq.${memberId},blocked_user_id.eq.${viewerId})`)
        .limit(1),
      db.from('matches')
        .select('id')
        .or(buildBidirectionalMatchFilter(viewerId, memberId))
        .neq('status', 'removed')
        .limit(1),
      db.from('intro_requests')
        .select('requester_id, target_user_id, status, is_admin_initiated')
        .or(`and(requester_id.eq.${viewerId},target_user_id.eq.${memberId}),and(requester_id.eq.${memberId},target_user_id.eq.${viewerId})`),
    ])
    // Any error → fail closed.
    if (blockRes.error || matchRes.error || introRes.error) return false
    return decideDiscoverability({
      viewerId,
      memberId,
      isBlocked: (blockRes.data ?? []).length > 0,
      hasActiveMatch: (matchRes.data ?? []).length > 0,
      introRows: (introRes.data ?? []) as IntroRow[],
    })
  } catch {
    return false
  }
}

/**
 * Batch form (NO N+1): given a set of candidate member ids, return the subset the
 * viewer may discover. Fetches the viewer's blocks / matches / intro_requests ONCE
 * and applies the same direction-aware rule per candidate. `db` MUST be a
 * service-role client. Fail-closed (empty set) on error.
 */
export async function discoverableMemberIds(
  db: { from: (t: string) => any },
  viewerId: string,
  candidateIds: string[],
): Promise<Set<string>> {
  const result = new Set<string>()
  const others = candidateIds.filter((id) => id && id !== viewerId)
  if (!viewerId || others.length === 0) return result

  try {
    const [blockRes, matchRes, introRes] = await Promise.all([
      db.from('blocked_users').select('user_id, blocked_user_id')
        .or(`user_id.eq.${viewerId},blocked_user_id.eq.${viewerId}`),
      db.from('matches').select('user_a_id, user_b_id, status')
        .or(`user_a_id.eq.${viewerId},user_b_id.eq.${viewerId}`),
      db.from('intro_requests').select('requester_id, target_user_id, status, is_admin_initiated')
        .or(`requester_id.eq.${viewerId},target_user_id.eq.${viewerId}`),
    ])
    if (blockRes.error || matchRes.error || introRes.error) return result

    const blocked = new Set<string>()
    for (const b of blockRes.data ?? []) blocked.add(b.user_id === viewerId ? b.blocked_user_id : b.user_id)

    const matched = new Set<string>()
    for (const m of matchRes.data ?? []) {
      if (m.status === 'removed') continue
      matched.add(m.user_a_id === viewerId ? m.user_b_id : m.user_a_id)
    }

    const introByOther = new Map<string, IntroRow[]>()
    for (const r of (introRes.data ?? []) as IntroRow[]) {
      const other = r.requester_id === viewerId ? r.target_user_id : r.requester_id
      if (!introByOther.has(other)) introByOther.set(other, [])
      introByOther.get(other)!.push(r)
    }

    for (const memberId of others) {
      if (decideDiscoverability({
        viewerId, memberId,
        isBlocked: blocked.has(memberId),
        hasActiveMatch: matched.has(memberId),
        introRows: introByOther.get(memberId) ?? [],
      })) result.add(memberId)
    }
    return result
  } catch {
    return result
  }
}
