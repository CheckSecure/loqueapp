import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Mobile responsiveness regressions for the member-facing dashboard.
 *
 * WHAT WENT WRONG. The Network page overflowed horizontally on iPhone. Two independent causes,
 * both measured in a real browser against the real compiled CSS:
 *
 *   1. The card is a GRID ITEM, and a grid item's default `min-width: auto` makes its automatic
 *      minimum size its MIN-CONTENT size. One unbreakable token — a URL in a bio, a very long
 *      company name — therefore sized the single mobile grid column to that token, and because a
 *      grid column is shared, EVERY card became that wide. Measured: 1093px of content inside a
 *      320px viewport, i.e. every card was ~3.4x the screen.
 *   2. The three action buttons (Message / Schedule / View) sat in a non-wrapping flex row whose
 *      combined min-content exceeded the card's inner width on narrow screens. Measured: 346px of
 *      content in a 320px viewport even with completely ordinary, short member data.
 *
 * The overflow was invisible as a scrollbar because the dashboard layout's <main> carries
 * `overflow-x-hidden` — so it CLIPPED instead, which is exactly what the bug report described:
 * cards running past the right edge, biography cut off sideways, the meeting button half off-screen.
 * That clip is retained ONLY as defence in depth; it is not the fix, and these tests pin the real
 * fixes so it can never silently become the fix again.
 *
 * SCOPE OF THESE TESTS. They assert the responsive CONTRACT (the classes that decide shrinking,
 * wrapping and touch size). They do not measure pixels — a real browser did that during the audit,
 * and page-level pixel measurement needs an authenticated session. See the report for what was
 * measured in a browser versus what still needs manual visual QA.
 */

const CARD = readFileSync('components/NetworkCard.tsx', 'utf8')
const NAV = readFileSync('components/MobileNav.tsx', 'utf8')
const LAYOUT = readFileSync('app/dashboard/layout.tsx', 'utf8')
const CONVO = readFileSync('components/messages/ConversationView.tsx', 'utf8')
const BANNER = readFileSync('components/EarlierIntroductionsBanner.tsx', 'utf8')
const HELP = readFileSync('components/FloatingHelp.tsx', 'utf8')
const FOCUS = readFileSync('components/CurrentFocusAreasInput.tsx', 'utf8')
const GLOBALS = readFileSync('app/globals.css', 'utf8')
const TITLE_SELECT = readFileSync('components/SearchableTitleSelect.tsx', 'utf8')
const EXPERTISE_SELECT = readFileSync('components/SearchableExpertiseSelect.tsx', 'utf8')

/** The block of JSX that renders the card's action row. */
const actionRow = CARD.slice(CARD.indexOf('gap-2 pt-3 border-t border-slate-100') - 24, CARD.lastIndexOf('<ConnectionDetailModal'))

describe('NetworkCard — cannot force the mobile grid column wider than the screen', () => {
  it('the card (a grid item) may shrink below its min-content', () => {
    const root = CARD.slice(CARD.indexOf('onClick={handleCardClick}'), CARD.indexOf('flex items-start gap-3'))
    expect(root).toMatch(/min-w-0/)
  })

  it('long identity text wraps on mobile and keeps desktop truncation', () => {
    // name, company/title line, secondary line, location
    const wrapped = CARD.match(/break-words sm:truncate/g) ?? []
    expect(wrapped.length).toBeGreaterThanOrEqual(4)
  })

  it('biography and metadata wrap instead of being clipped sideways', () => {
    expect(CARD).toMatch(/line-clamp-2 break-words/)          // bio
    expect(CARD).toMatch(/text-xs text-slate-400 break-words/) // "Introduced through Andrel …"
  })

  it('the identity rows can shrink (min-w-0 at the flex boundary)', () => {
    expect(CARD).toMatch(/flex items-start sm:items-center gap-1 text-xs text-slate-500 min-w-0/)
    expect(CARD).toMatch(/flex items-start sm:items-center gap-1 text-xs text-slate-400 mt-0\.5 min-w-0/)
  })

  it('never relies on a fixed pixel width', () => {
    expect(CARD).not.toMatch(/\bw-\[\d{3,}px\]/)
    expect(CARD).not.toMatch(/\bmin-w-\[\d{3,}px\]/)
  })
})

describe('NetworkCard — action row fits, wraps, and stays tappable', () => {
  it('wraps instead of overflowing when the three buttons do not fit', () => {
    expect(actionRow).toMatch(/flex flex-wrap gap-2/)
  })

  it('every action can shrink below its content width', () => {
    expect((actionRow.match(/min-w-0/g) ?? []).length).toBe(3)
  })

  it('every action keeps a >=44px touch target', () => {
    expect((actionRow.match(/min-h-\[44px\]/g) ?? []).length).toBe(3)
  })

  it('keeps visible text labels — never a clipped icon-only control', () => {
    for (const label of ['Message', 'Schedule', 'View']) expect(actionRow).toContain(label)
  })

  it('icons never shrink and the icon-only affordance keeps its accessible name', () => {
    expect((actionRow.match(/w-3\.5 h-3\.5 flex-shrink-0/g) ?? []).length).toBe(3)
    expect(actionRow).toMatch(/aria-label="View full profile"/)
  })

  it('gives each action a sensible flex basis so wide cards still show one row', () => {
    expect(actionRow).toMatch(/basis-28/)
    expect(actionRow).toMatch(/basis-20/)
  })
})

describe('MobileNav — six tabs, safe area, no overflow', () => {
  it('reserves the home-indicator inset instead of sitting under it', () => {
    expect(NAV).toMatch(/h-\[calc\(4rem\+env\(safe-area-inset-bottom\)\)\]/)
    expect(NAV).toMatch(/pb-\[env\(safe-area-inset-bottom\)\]/)
  })

  it('clears the status-bar inset at the top', () => {
    expect(NAV).toMatch(/pt-\[env\(safe-area-inset-top\)\]/)
  })

  it('every tab can shrink, so six tabs never widen the bar', () => {
    expect((NAV.match(/flex-1 min-w-0 flex flex-col/g) ?? []).length).toBe(2) // nav links + More
    expect(NAV).toMatch(/max-w-full truncate/)
  })

  it('the More sheet sits above the bar including the inset, and scrolls if tall', () => {
    expect(NAV).toMatch(/bottom-\[calc\(4rem\+env\(safe-area-inset-bottom\)\)\]/)
    expect(NAV).toMatch(/max-h-\[70vh\] overflow-y-auto/)
  })
})

describe('dashboard layout — bottom clearance and the defensive clip', () => {
  it('adds the safe-area inset once for every dashboard page', () => {
    expect(LAYOUT).toMatch(/pb-\[env\(safe-area-inset-bottom\)\] md:pb-0/)
  })

  it('still carries overflow-x-hidden ONLY as defence in depth', () => {
    // Documented deliberately: the real sources are fixed above. If this line is ever treated as
    // the fix again, the tests above are what will fail first.
    expect(LAYOUT).toMatch(/overflow-x-hidden/)
  })
})

describe('other member-facing overflow sources found in the audit', () => {
  it('the message edit box may shrink on mobile', () => {
    // 220px inside a max-w-[75%] bubble overflowed a 320px screen while editing.
    expect(CONVO).toMatch(/min-w-0 sm:min-w-\[220px\]/)
    expect(CONVO).not.toMatch(/className="min-w-\[220px\]"/)
  })

  it('the earlier-introductions CTA can wrap on mobile', () => {
    expect(BANNER).toMatch(/whitespace-normal sm:whitespace-nowrap/)
  })
})


describe('FloatingHelp — separated from the mobile bottom bar', () => {
  it('is hidden on mobile, where a fixed control cannot avoid covering scrolling actions', () => {
    // Measured overlapping a Network card action at 320px. A fixed FAB passes over some button at
    // every width mid-scroll, so on mobile it is removed entirely rather than clipped or shrunk.
    expect(HELP).toMatch(/hidden md:block fixed/)
  })

  it('keeps its desktop position and its safe-area offset', () => {
    expect(HELP).toMatch(/bottom-\[calc\(4\.5rem\+env\(safe-area-inset-bottom\)\)\]/)
    expect(HELP).toMatch(/md:right-6 md:bottom-6/)
  })

  it('mobile keeps the capability via the More sheet instead of losing it', () => {
    expect(NAV).toMatch(/Help &amp; guided tour/)
    expect(NAV).toMatch(/OPEN_TUTORIAL_EVENT/)
    // and that entry is itself a proper touch target
    const help = NAV.slice(NAV.indexOf('Help &amp; guided tour') - 400, NAV.indexOf('Help &amp; guided tour'))
    expect(help).toMatch(/min-h-\[44px\]/)
  })
})

describe('form controls — overflow and iOS zoom', () => {
  it('the focus-areas row can shrink instead of pushing its button off-screen', () => {
    // Measured: main scrollWidth 329 vs clientWidth 320 on /dashboard/profile at 320px, caused by
    // this input's automatic minimum size (its intrinsic default width) in a flex row.
    expect(FOCUS).toMatch(/flex-1 min-w-0 px-3\.5/)
    expect(FOCUS).toMatch(/inline-flex flex-shrink-0 min-h-\[44px\]/)
  })

  it('mobile form controls are 16px so iOS never zooms on focus', () => {
    expect(GLOBALS).toMatch(/prevent iOS focus zoom/)
    expect(GLOBALS).toMatch(/@media \(max-width: 767px\)/)
    // specificity must beat Tailwind's .text-sm (0,1,0) or the rule silently loses
    expect(GLOBALS).toMatch(/select:not\(\[hidden\]\)/)
    expect(GLOBALS).toMatch(/textarea:not\(\[hidden\]\)/)
  })

  it('desktop typography is untouched by that rule', () => {
    // scoped to max-width:767px only — no unconditional font-size override
    expect(GLOBALS).not.toMatch(/^\s*(input|textarea|select)\s*\{\s*font-size/m)
  })

  it('the picker buttons meet the touch target', () => {
    expect(TITLE_SELECT).toMatch(/min-h-\[44px\]/)
    expect(EXPERTISE_SELECT).toMatch(/min-h-\[44px\]/)
  })

  it('text-styled buttons in the banner are still real touch targets', () => {
    expect((BANNER.match(/min-h-\[44px\]/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})


describe('chips — compact pill, full-size hit target', () => {
  /**
   * Measured in Chrome on a hydrated page: every chip's real interactive box is >= 44x44
   * (smallest = 48x44 for "AI"), with zero overlaps between adjacent chips and zero chips
   * crossing the viewport at 320/360/390/430.
   *
   * The VISIBLE pill is untouched — same height, padding and type scale. The target is supplied by
   * a centred ::after overlay, and the row gap is widened so two stacked chips' expanded regions
   * cannot overlap ((44-24)/2 = 10px of growth above and below each chip needs >= 20px of row gap).
   */
  const HIT = /after:absolute after:left-1\/2 after:top-1\/2 after:h-11 after:w-full after:min-w-\[44px\]/

  it('removable expertise chips carry a 44px hit overlay without changing the pill', () => {
    expect(EXPERTISE_SELECT).toMatch(HIT)
    expect(EXPERTISE_SELECT).toMatch(/relative after:absolute/)
    // the visible pill keeps its original compact padding/type
    expect(EXPERTISE_SELECT).toMatch(/rounded-full bg-\[#1B2850\] px-2\.5 py-1 text-xs/)
  })

  it('suggestion tags carry the same overlay and keep their compact pill', () => {
    expect(FOCUS).toMatch(HIT)
    expect(FOCUS).toMatch(/rounded-full border border-slate-200 bg-white px-2\.5 py-0\.5 text-\[13px\]/)
  })

  it('row gap is widened so expanded hit regions cannot overlap', () => {
    expect(EXPERTISE_SELECT).toMatch(/flex flex-wrap gap-x-1\.5 gap-y-5/)
    expect(FOCUS).toMatch(/flex flex-wrap gap-x-1\.5 gap-y-5/)
  })

  it('chips remain real buttons with their accessible names', () => {
    expect(EXPERTISE_SELECT).toMatch(/type="button"/)
    expect(EXPERTISE_SELECT).toMatch(/aria-label=\{`Remove \$\{tag\}`\}/)
    // the overlay is decorative content only — it must not become a focusable element
    expect(EXPERTISE_SELECT).toMatch(/after:content-\[''\]/)
  })
})

describe('More sheet — open state', () => {
  /**
   * Browser-verified on a hydrated build by clicking the real More button at 320/360/390/430 with a
   * 34px safe-area inset: the sheet spans exactly the viewport, its bottom edge meets the nav's top
   * edge (never beneath it), every action is >= 44px, the document and main width invariants hold,
   * the Help entry dispatches the real OPEN_TUTORIAL_EVENT (observed count 1) and closes the sheet,
   * and the mobile FloatingHelp stays hidden behind/above it.
   */
  it('is width-bounded by construction and clears the nav including the inset', () => {
    expect(NAV).toMatch(/fixed bottom-\[calc\(4rem\+env\(safe-area-inset-bottom\)\)\] left-0 right-0/)
  })

  it('scrolls internally rather than growing past the screen', () => {
    expect(NAV).toMatch(/max-h-\[70vh\] overflow-y-auto/)
  })

  it('its dismiss control is a real 44px target with an accessible name', () => {
    // measured 16x16 before this fix
    expect(NAV).toMatch(/aria-label="Close menu"/)
    expect(NAV).toMatch(/h-11 w-11 items-center justify-center/)
  })

  it('every sheet action is a full-width row with a 44px-tall target', () => {
    const sheet = NAV.slice(NAV.indexOf('rounded-t-2xl'), NAV.indexOf('Bottom nav'))
    expect((sheet.match(/px-3 py-3/g) ?? []).length).toBeGreaterThanOrEqual(4)
    expect(sheet).toMatch(/Help &amp; guided tour/)
  })
})
