'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

/**
 * Resets the dashboard's scroll pane to the top on every route change.
 *
 * WHY THIS IS NEEDED. Next's App Router restores/resets scroll on the DOCUMENT. From md upward the
 * document no longer scrolls — `<main id="dashboard-main">` does — so without this a member who
 * scrolled to the bottom of a long Network list and then opened Messages would arrive already
 * scrolled down, looking at the middle of the new page.
 *
 * CHOSEN BEHAVIOUR, stated plainly: every route change starts at the top, including browser
 * back/forward. That matches what the document scroll owner did for forward navigation, and it is
 * predictable. The one deliberate trade-off is that going BACK to a long list no longer restores
 * the previous position the way native document scroll restoration would — recording and replaying
 * per-route offsets is a larger change and is not attempted here.
 *
 * Below md this is a no-op in practice: the document is still the scroll owner and Next already
 * handles it, and resetting an element that is not scrolled changes nothing.
 */
export default function MainScrollReset() {
  const pathname = usePathname()

  useEffect(() => {
    const main = document.getElementById('dashboard-main')
    // Guard rather than assume: the element is absent during the brief window before hydration,
    // and on any surface that renders this component without the shell.
    if (!main) return
    // `auto` (not `smooth`) — a route change should land at the top immediately, not animate.
    main.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [pathname])

  return null
}
