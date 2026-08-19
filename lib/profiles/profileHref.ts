/**
 * The one place a member-profile URL is built.
 *
 * WHY THIS EXISTS: member-profile links were assembled by hand at every call site, so nothing
 * guaranteed they agreed on the route, on which identifier belongs in it, or on what to do when
 * the identifier is missing. A hand-built href with an absent id silently produces
 * `/dashboard/profile/undefined`, which is a fabricated URL that can only ever 404.
 *
 * CONTRACT
 *   - The ONLY accepted identifier is the member's profile UUID (profiles.id). Names, emails,
 *     titles, conversation ids, match ids and pair ids are never routable: they are unstable,
 *     and several are private.
 *   - Returns `null` when the identifier is absent or not a UUID. Callers MUST treat null as
 *     "render no link" rather than falling back to a guessed URL — see the Messages header.
 *   - Viewing yourself resolves to your own editable profile, matching the destination route's
 *     own `params.id === user.id` redirect, so the two can never disagree.
 *
 * This builder deliberately makes NO authorization decision. Whether the viewer may see a given
 * member is decided server-side on the destination page (canViewerDiscoverMember + the
 * discovery-scoped public_profiles view). A link existing is not permission to view.
 */

/** Canonical member-profile route. Kept here so the path is written exactly once. */
export const MEMBER_PROFILE_BASE = '/dashboard/profile'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isMemberProfileId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value.trim())
}

/**
 * Build the profile href for a member, or null when no safe link can be made.
 *
 * @param memberId  the OTHER member's profiles.id
 * @param viewerId  the signed-in member's id, when known — lets self resolve to the own-profile page
 */
export function memberProfileHref(
  memberId: string | null | undefined,
  viewerId?: string | null,
): string | null {
  if (!isMemberProfileId(memberId)) return null
  const id = memberId.trim()
  if (viewerId && isMemberProfileId(viewerId) && viewerId.trim() === id) return MEMBER_PROFILE_BASE
  // encodeURIComponent is belt-and-braces: the value is already a validated UUID, so it cannot
  // contain a path separator or query character, but the escape keeps that guarantee local.
  return `${MEMBER_PROFILE_BASE}/${encodeURIComponent(id)}`
}
