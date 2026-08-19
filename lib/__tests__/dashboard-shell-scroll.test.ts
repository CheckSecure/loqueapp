import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Desktop dashboard shell: the sidebar stays put, the main pane scrolls.
 *
 * WHAT WAS WRONG. The shell was `min-h-screen md:flex` — a MINIMUM height, so it grew with its
 * content and the DOCUMENT owned vertical scrolling. The sidebar was an ordinary in-flow flex
 * child, so scrolling a long Network list carried navigation, the credit balance, the member's
 * name and Sign out off the top of the screen. The sidebar's `nav` already had `overflow-y-auto`,
 * but it could never engage because the aside had no bounded height to overflow.
 *
 * WHAT IT IS NOW (md and up only): the shell is exactly one viewport tall and scrolls nothing
 * itself; `<main>` is the scroll owner. Below md nothing changes — the document still scrolls,
 * which is what the fixed MobileNav and its safe-area padding depend on.
 *
 * MEASURED IN CHROME against the real compiled CSS, at 1024x600 / 1280x720 / 1366x768 / 1440x900 /
 * 1920x1080 / 768x1024 with a 24-card Network list: with the pane scrolled to the bottom the
 * sidebar's top stayed at 0 (unmoved), main.scrollTop reached up to 4356, the document never
 * scrolled, and nav + credits + account + Sign out all remained visible. Mobile 320/375/390/430
 * kept the document as scroll owner with no sidebar. These assertions pin the structure that
 * produces those numbers.
 */

const LAYOUT = readFileSync('app/dashboard/layout.tsx', 'utf8')
const SIDEBAR = readFileSync('components/Sidebar.tsx', 'utf8')
const GLOBALS = readFileSync('app/globals.css', 'utf8')
const RESET = readFileSync('components/MainScrollReset.tsx', 'utf8')

describe('the shell owns the viewport, not the scroll', () => {
  it('is exactly one viewport tall from md up, with a 100vh fallback before 100dvh', () => {
    const rule = GLOBALS.slice(GLOBALS.indexOf('.dashboard-shell'), GLOBALS.indexOf('.dashboard-shell') + 220)
    expect(rule).toMatch(/height:\s*100vh/)
    expect(rule).toMatch(/height:\s*100dvh/)
    // the fallback must come FIRST or it would override the dynamic unit
    expect(rule.indexOf('100vh')).toBeLessThan(rule.indexOf('100dvh'))
  })

  it('only applies at md and above, so mobile keeps document scrolling', () => {
    const at = GLOBALS.indexOf('.dashboard-shell')
    const media = GLOBALS.lastIndexOf('@media (min-width: 768px)', at)
    expect(media).toBeGreaterThan(-1)
    expect(at - media).toBeLessThan(900) // the rule sits inside that md query
  })

  it('the shell itself never scrolls — main does', () => {
    const rule = GLOBALS.slice(GLOBALS.indexOf('.dashboard-shell'), GLOBALS.indexOf('.dashboard-shell') + 220)
    expect(rule).toMatch(/overflow:\s*hidden/)
    expect(LAYOUT).toMatch(/className="dashboard-shell min-h-screen md:flex/)
  })

  it('main is the vertical scroll owner and can actually shrink to the shell', () => {
    const main = LAYOUT.slice(LAYOUT.indexOf('<main'), LAYOUT.indexOf('>', LAYOUT.indexOf('<main')))
    expect(main).toMatch(/md:overflow-y-auto/)
    expect(main).toMatch(/md:h-full/)
    expect(main).toMatch(/md:min-h-0/)   // without this a flex child grows to content and never scrolls
    expect(main).toMatch(/min-w-0/)      // keeps the mobile horizontal-overflow fix intact
    expect(main).toMatch(/id="dashboard-main"/)
  })

  it('keeps the mobile safe-area padding and the defensive x-clip', () => {
    const main = LAYOUT.slice(LAYOUT.indexOf('<main'), LAYOUT.indexOf('>', LAYOUT.indexOf('<main')))
    expect(main).toMatch(/pb-\[env\(safe-area-inset-bottom\)\] md:pb-0/)
    expect(main).toMatch(/overflow-x-hidden/)
  })
})

describe('sidebar structure survives a bounded height', () => {
  it('is a full-height flex column that may shrink', () => {
    const aside = SIDEBAR.slice(SIDEBAR.indexOf('<aside'), SIDEBAR.indexOf('>', SIDEBAR.indexOf('<aside')))
    expect(aside).toMatch(/hidden md:flex flex-col/)   // still absent below md
    expect(aside).toMatch(/h-full min-h-0/)
    expect(aside).toMatch(/shrink-0/)                  // fixed-width column, never squeezed
    expect(aside).toMatch(/w-64/)
  })

  it('brand header and the membership/account block are never compressed away', () => {
    expect(SIDEBAR).toMatch(/shrink-0 px-6 py-7 border-b/)       // brand
    expect(SIDEBAR).toMatch(/shrink-0 px-4 pb-5 pt-4 border-t/)  // credits + account + sign out
  })

  it('on a short viewport it is the NAV that scrolls, not the account controls', () => {
    // measured: at 1024x600 the nav scrolled internally while credits/account/sign-out stayed visible
    expect(SIDEBAR).toMatch(/flex-1 min-h-0 px-3 py-5 space-y-0\.5 overflow-y-auto/)
  })

  it('still renders every destination the member must not lose', () => {
    for (const label of ['Introductions', 'Opportunities', 'Network', 'Messages', 'Meetings', 'Profile', 'Billing', 'Settings', 'Admin', 'Sign out']) {
      expect(SIDEBAR).toContain(label)
    }
    expect(SIDEBAR).toMatch(/Membership/)
  })
})

describe('route changes land at the top of the new page', () => {
  it('resets the pane, because Next only resets the document', () => {
    expect(RESET).toMatch(/getElementById\('dashboard-main'\)/)
    expect(RESET).toMatch(/usePathname/)
    expect(RESET).toMatch(/scrollTo\(\{ top: 0/)
    expect(RESET).toMatch(/behavior: 'auto'/)
  })

  it('is guarded so a missing pane cannot throw', () => {
    expect(RESET).toMatch(/if \(!main\) return/)
  })

  it('is mounted inside the dashboard shell', () => {
    expect(LAYOUT).toMatch(/<MainScrollReset \/>/)
    expect(LAYOUT).toMatch(/from '@\/components\/MainScrollReset'/)
  })
})

describe('mobile shell is untouched', () => {
  it('adds no desktop sidebar and no viewport-height clamp below md', () => {
    // every shell/main height + overflow change is md-prefixed or inside the md media query
    const main = LAYOUT.slice(LAYOUT.indexOf('<main'), LAYOUT.indexOf('>', LAYOUT.indexOf('<main')))
    expect(main).not.toMatch(/(?<!md:)h-full/)
    expect(main).not.toMatch(/(?<!md:)overflow-y-auto/)
    expect(LAYOUT).toMatch(/min-h-screen/)             // mobile still grows with content
  })

  it('keeps MobileNav and the floating-help decision as deployed', () => {
    expect(LAYOUT).toMatch(/<MobileNav/)
    expect(readFileSync('components/FloatingHelp.tsx', 'utf8')).toMatch(/hidden md:block fixed/)
  })
})
