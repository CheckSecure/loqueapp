// Where the Andrel wordmark goes, decided in ONE place.
//
// WHY THIS EXISTS. The wordmark was written independently on every surface. Eleven public and auth
// pages each hard-coded <Link href="/">, and four surfaces — the landing nav, the dashboard
// sidebar, the mobile dashboard header and the invitation-resume card — rendered it as a bare
// <span>, so it was not clickable at all. There was no shared component and no shared answer to
// "where should this go?", which is why the four dead ones went unnoticed.
//
// THE RULE. A logged-out visitor goes to the public homepage. A member who is already
// authenticated goes to the canonical authenticated landing page — the same destination
// app/dashboard/page.tsx redirects to and app/login/page.tsx pushes to after sign-in.
//
// WHAT THIS IS NOT. It performs no auth check of its own. It is a pure mapping from a boolean the
// CALLER already knows, so a server component that has resolved the session can resolve the href
// without a second round-trip and a client component can be handed the answer as a prop. Nothing
// here reads cookies, localStorage, or a browser-only "logged in" guess.

/** The public homepage. Where a logged-out visitor's wordmark goes. */
export const PUBLIC_LOGO_HREF = '/'

/**
 * The canonical authenticated landing page. Kept identical to app/dashboard/page.tsx's redirect
 * and app/login/page.tsx's post-sign-in push, so all three agree by construction.
 *
 * The server guards remain authoritative: a member with an unstarted profile who follows this link
 * is still sent to /onboarding by app/dashboard/layout.tsx. This changes where the wordmark POINTS,
 * never who is allowed to arrive.
 */
export const AUTHENTICATED_LOGO_HREF = '/dashboard/introductions'

/** The accessible name for the wordmark link, so its destination is stated rather than implied. */
export const LOGO_ARIA_LABEL = 'Andrel home'

/** Resolve the wordmark destination from an authentication state the caller already knows. */
export function logoHref(isAuthenticated: boolean): string {
  return isAuthenticated ? AUTHENTICATED_LOGO_HREF : PUBLIC_LOGO_HREF
}
