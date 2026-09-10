// What the authenticated shell looks like for each community, decided in ONE place.
//
// WHY THIS EXISTS, and why it is a module rather than two local constants. The dashboard shell is
// rendered by two independent components — components/Sidebar.tsx (desktop) and
// components/MobileNav.tsx (mobile) — which do not share a nav list, a layout, or a single line of
// markup. Sidebar filters an array; MobileNav hard-codes its links across a bottom bar and a "More"
// sheet. Written twice, "which destinations does an Andrel Next member not see?" is two answers that
// agree today and drift the first time a nav item is added to one of them.
//
// This is the same argument lib/nav/logoHref.ts makes for the wordmark destination, and it sits
// beside it for the same reason: the answer belongs to navigation, not to either renderer.
//
// ─── PRESENTATION ONLY. NOT A BOUNDARY. ───────────────────────────────────────────────────────
// Nothing here decides who may REACH a route. /dashboard/opportunities and /dashboard/billing close
// themselves server-side against a service_role read of the caller's own profile row
// (lib/community/viewerCommunity.ts), and the Opportunities create/respond APIs refuse the same way.
// Those gates are the authority and are entirely independent of this file: deleting every line here
// would make two links visible and change nothing about what a Next member can actually do.
//
// The input is a prop that reached a client component, so it proves nothing. It is used to decide
// what to draw and for nothing else.

import type { MemberType } from '@/lib/community/memberType'

/**
 * Destinations an Andrel Next member does not see in the shell.
 *
 * Opportunities is Professional business development — signalling a hiring or business need to
 * other senior professionals. Billing sells three Professional tiers, two of them priced on
 * Opportunities; there is no student subscription product and none is being invented here.
 *
 * Matched on HREF rather than label, so a copy change cannot silently unhide a destination.
 */
export const NEXT_HIDDEN_NAV_HREFS: ReadonlySet<string> = new Set([
  '/dashboard/opportunities',
  '/dashboard/billing',
])

/**
 * Does this viewer get Andrel Next chrome?
 *
 * FAILS CLOSED TO PROFESSIONAL, and the strict equality is the whole implementation: an absent,
 * null, misspelled or future-third-community value is not 'next', so it renders exactly today's
 * Professional shell. There is deliberately no "unknown" branch to get wrong — Professional is what
 * every member has today, and rendering it for a value we do not understand is the outcome that
 * cannot surprise anyone.
 *
 * Typed loosely on purpose. The prop is typed MemberType, but it arrives from a server component
 * through a client boundary, and this predicate is the one place that should have to care what
 * happens if something else ever turns up there.
 */
export function showsNextChrome(memberType: MemberType | string | null | undefined): boolean {
  return memberType === 'next'
}

/** True when this destination should be rendered for this viewer. */
export function showsNavHref(
  href: string,
  memberType: MemberType | string | null | undefined,
): boolean {
  return !showsNextChrome(memberType) || !NEXT_HIDDEN_NAV_HREFS.has(href)
}

/**
 * The wordmark suffix. "Andrel" for a professional; "Andrel Next" for a student.
 *
 * A SUFFIX, NOT A SECOND BRAND. The two communities are one product family, so the treatment is the
 * existing wordmark plus a small, lighter word on the same baseline — no second logo, no second
 * palette, no second design system. Rendered as a SIBLING of the wordmark link rather than inside
 * it, so the link's destination, accessible name and clickable area stay exactly what they are for
 * everyone (see lib/nav/logoHref.ts).
 *
 * Empty string for Professional, so the suffix element renders nothing at all rather than an empty
 * node with spacing.
 */
export const NEXT_WORDMARK_SUFFIX = 'Next'

/** The suffix to render beside the wordmark, or '' when there is none. */
export function wordmarkSuffix(memberType: MemberType | string | null | undefined): string {
  return showsNextChrome(memberType) ? NEXT_WORDMARK_SUFFIX : ''
}
