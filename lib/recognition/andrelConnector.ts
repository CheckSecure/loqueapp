/**
 * Andrel Connector — the single source of the name, the copy and the "should this render" rule.
 *
 * THE NAME IS FIXED. It is "Andrel Connector" in every surface, every identifier and every column.
 * Never "influencer" (it is not reach or a following) and never "connecter" (a misspelling that
 * would then be permanent in a database column). A lint-style test asserts both are absent.
 *
 * WHAT IT MEANS. Recognition, awarded by hand, for members who thoughtfully expand the community.
 * It is deliberately NOT a threshold, NOT a count and NOT a ranking: nothing here reads referral or
 * nomination data, and no code path awards it automatically.
 */

/** The member-facing label. Used by the badge and by the admin control. */
export const ANDREL_CONNECTOR_LABEL = 'Andrel Connector'

/** Revealed on hover, focus or tap. Also the badge's accessible description. */
export const ANDREL_CONNECTOR_TOOLTIP = 'Recognized for thoughtfully expanding the Andrel community.'

/** Shown under the admin control so the criterion is stated where it is applied. */
export const ANDREL_CONNECTOR_ADMIN_HELP =
  'Recognizes members who thoughtfully expand the Andrel community.'

/**
 * Whether a profile currently holds the recognition.
 *
 * Strictly `=== true`, so a legacy row that predates the column, a payload that omitted it, `null`,
 * `undefined` or the string 'false' all render UNBADGED. A badge is an assertion about a person; it
 * must never appear because a value was merely truthy.
 */
export function isAndrelConnector(
  profile: { is_andrel_connector?: unknown } | null | undefined,
): boolean {
  return profile?.is_andrel_connector === true
}
