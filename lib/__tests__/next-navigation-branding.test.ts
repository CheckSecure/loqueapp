import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STEP 3 — ANDREL NEXT NAVIGATION AND BRANDING.
 *
 * ─── WHAT THIS STEP IS, AND WHAT IT IS NOT ────────────────────────────────────────────────────
 * Presentation only. Step 2 closed /dashboard/opportunities and /dashboard/billing server-side
 * against a service_role read of the caller's own profile row, and refused the create/respond APIs
 * the same way. Those gates are the authority and are untouched here.
 *
 * So this step removes two links that would BOUNCE, and adds a word to a wordmark. Deleting every
 * line of it would make the links visible again and change nothing about what a Next member can
 * actually reach — which is exactly the property the last describe block asserts, because a
 * navigation change that quietly became load-bearing is the failure mode worth guarding against.
 *
 * Rendering is real: components are rendered with renderToStaticMarkup and the MARKUP is asserted,
 * following the pattern lib/__tests__/post-onboarding-landing.test.ts already established. Only the
 * mobile "More" sheet is pinned structurally instead — it is behind `showMore` state that a static
 * render never opens, so there is no markup to read.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  redirect: vi.fn(),
  usePathname: () => '/dashboard/introductions',
  useSearchParams: () => new URLSearchParams(),
}))

const SIDEBAR = readFileSync('components/Sidebar.tsx', 'utf8')
const MOBILE = readFileSync('components/MobileNav.tsx', 'utf8')
const NAV = readFileSync('lib/nav/communityNav.ts', 'utf8')

import {
  NEXT_HIDDEN_NAV_HREFS, NEXT_WORDMARK_SUFFIX, showsNextChrome, showsNavHref, wordmarkSuffix,
} from '@/lib/nav/communityNav'

const render = async (el: any) => {
  const { renderToStaticMarkup } = await import('react-dom/server')
  return renderToStaticMarkup(el)
}

const BASE = {
  displayName: 'Ada Example', email: 'ada@example.com', initials: 'AE',
  avatarColor: 'bg-slate-600', avatarUrl: null, credits: 7,
  unreadCount: 0, networkNotifCount: 0, meetingNotifCount: 0,
  opportunityBadgeCount: 0, adminBadgeCount: 0, logoHref: '/dashboard/introductions',
}

async function sidebar(memberType?: any) {
  const { default: Sidebar } = await import('@/components/Sidebar')
  const React = await import('react')
  return render(React.createElement(Sidebar as any, { ...BASE, ...(memberType !== undefined ? { memberType } : {}) }))
}

async function mobile(memberType?: any) {
  const { default: MobileNav } = await import('@/components/MobileNav')
  const React = await import('react')
  return render(React.createElement(MobileNav as any, { ...BASE, ...(memberType !== undefined ? { memberType } : {}) }))
}

/** Every destination the Professional shell offers, as hrefs. */
const ALL = {
  introductions: '/dashboard/introductions',
  network: '/dashboard/network',
  messages: '/dashboard/messages',
  meetings: '/dashboard/meetings',
  profile: '/dashboard/profile',
  settings: '/dashboard/settings',
  opportunities: '/dashboard/opportunities',
  billing: '/dashboard/billing',
}

// ═══ 1. THE SHARED DECISION ═══════════════════════════════════════════════════════════════════
describe('1. one definition of what a Next member does not see', () => {
  it('names exactly the two Professional-only destinations', () => {
    expect(Array.from(NEXT_HIDDEN_NAV_HREFS).sort()).toEqual([ALL.billing, ALL.opportunities])
  })

  it('hides those two from a Next member and nothing else', () => {
    for (const href of Object.values(ALL)) {
      const hidden = NEXT_HIDDEN_NAV_HREFS.has(href)
      expect(showsNavHref(href, 'next')).toBe(!hidden)
    }
  })

  it('hides NOTHING from a professional', () => {
    for (const href of Object.values(ALL)) expect(showsNavHref(href, 'professional')).toBe(true)
  })

  it('BOTH components consult it — the answer is not written twice', () => {
    expect(SIDEBAR).toMatch(/from '@\/lib\/nav\/communityNav'/)
    expect(MOBILE).toMatch(/from '@\/lib\/nav\/communityNav'/)
    // Neither re-declares its own hidden list.
    for (const src of [SIDEBAR, MOBILE]) {
      expect(src).not.toMatch(/=\s*new Set\(\[[\s\S]{0,120}\/dashboard\/billing/)
    }
  })
})

// ═══ 2. FAIL-CLOSED PRESENTATION ══════════════════════════════════════════════════════════════
describe('2. anything that is not exactly "next" renders the Professional shell', () => {
  it.each([
    ['professional', 'professional'], ['undefined', undefined], ['null', null], ['empty', ''],
    ['whitespace', ' next '], ['wrong case', 'NEXT'], ['typo', 'nextt'],
    ['a lookalike', 'next-community'], ['a number', 7], ['an object', {}], ['true', true],
  ])('%s does not produce Next chrome', (_label, value) => {
    expect(showsNextChrome(value as any)).toBe(false)
    expect(wordmarkSuffix(value as any)).toBe('')
    expect(showsNavHref(ALL.opportunities, value as any)).toBe(true)
    expect(showsNavHref(ALL.billing, value as any)).toBe(true)
  })

  it('only the exact string produces it', () => {
    expect(showsNextChrome('next')).toBe(true)
    expect(wordmarkSuffix('next')).toBe(NEXT_WORDMARK_SUFFIX)
  })

  it('an OMITTED prop renders exactly the Professional sidebar', async () => {
    expect(await sidebar(undefined)).toBe(await sidebar('professional'))
  })

  it('an OMITTED prop renders exactly the Professional mobile nav', async () => {
    expect(await mobile(undefined)).toBe(await mobile('professional'))
  })

  it('an UNRECOGNISED value renders exactly the Professional shell', async () => {
    const pro = await sidebar('professional')
    for (const bogus of ['student', 'NEXT', 'nextt', '', null]) {
      expect(await sidebar(bogus)).toBe(pro)
    }
    const proMobile = await mobile('professional')
    for (const bogus of ['student', 'NEXT', 'nextt', '', null]) {
      expect(await mobile(bogus)).toBe(proMobile)
    }
  })
})

// ═══ 3. SIDEBAR — NEXT ════════════════════════════════════════════════════════════════════════
describe('3. the Next sidebar', () => {
  it('hides Opportunities', async () => {
    const html = await sidebar('next')
    expect(html).not.toContain(ALL.opportunities)
    expect(html).not.toContain('Opportunities')
  })

  it('hides Billing', async () => {
    const html = await sidebar('next')
    expect(html).not.toContain(ALL.billing)
    expect(html).not.toContain('Billing')
  })

  it('hides the credits chip AND its whole membership card', async () => {
    const html = await sidebar('next')
    expect(html).not.toContain('Membership')
    expect(html).not.toContain('Upgrade')
    expect(html).not.toContain('credit')      // "7 credits" / "No credits remaining"
    expect(html).not.toContain('billing#credits')
  })

  it.each([
    ['Introductions', ALL.introductions], ['Network', ALL.network], ['Messages', ALL.messages],
    ['Meetings', ALL.meetings], ['Profile', ALL.profile], ['Settings', ALL.settings],
  ])('still shows %s', async (label, href) => {
    const html = await sidebar('next')
    expect(html).toContain(href)
    expect(html).toContain(label)
  })

  it('renders Andrel Next branding', async () => {
    const html = await sidebar('next')
    expect(html).toContain('Andrel')
    expect(html).toContain(NEXT_WORDMARK_SUFFIX)
    // The two words read as one wordmark on one baseline, in the existing palette — not a second logo.
    expect(html).toMatch(/Andrel<\/a>[\s\S]{0,160}>Next</)
    expect(SIDEBAR).toMatch(/flex items-baseline/)
  })

  it('keeps the identity block and sign-out', async () => {
    const html = await sidebar('next')
    expect(html).toContain('Ada Example')
    expect(html).toContain('Sign out')
  })
})

// ═══ 4. SIDEBAR — PROFESSIONAL, UNCHANGED ═════════════════════════════════════════════════════
describe('4. the Professional sidebar is today\'s sidebar', () => {
  it.each(Object.entries(ALL))('still shows %s', async (_label, href) => {
    expect(await sidebar('professional')).toContain(href)
  })

  it('still shows Opportunities and Billing by name', async () => {
    const html = await sidebar('professional')
    expect(html).toContain('Opportunities')
    expect(html).toContain('Billing')
  })

  it('still shows the credits chip and the membership card', async () => {
    const html = await sidebar('professional')
    expect(html).toContain('Membership')
    expect(html).toContain('Upgrade')
    expect(html).toContain('7 credits')
    expect(html).toContain('billing#credits')
  })

  it('renders the wordmark as plain Andrel, with NO suffix', async () => {
    const html = await sidebar('professional')
    expect(html).toContain('Andrel')
    expect(html).not.toMatch(/Andrel<\/a>[\s\S]{0,160}>Next</)
    expect(html).not.toContain('>Next<')
  })

  it('the nav list itself is ONE array — there is no second list for Next', () => {
    const decl = SIDEBAR.slice(SIDEBAR.indexOf('const navItems = ['), SIDEBAR.indexOf('interface SidebarProps'))
    for (const label of ['Introductions', 'Opportunities', 'Network', 'Messages', 'Meetings', 'Profile', 'Billing', 'Settings']) {
      expect(decl).toContain(label)
    }
    // The array is unconditional; the FILTER happens at render.
    expect(decl).not.toMatch(/memberType|isNext|showsNav/)
    expect(SIDEBAR).toMatch(/navItems\.filter\(\(\{ href \}\) => showsNavHref\(href, memberType\)\)/)
    expect(SIDEBAR).not.toMatch(/const nextNavItems|navItemsForNext/)
  })
})

// ═══ 5. MOBILE NAV — NEXT ═════════════════════════════════════════════════════════════════════
describe('5. the Next mobile nav', () => {
  it('exposes NO billing or credits destination in the header', async () => {
    const html = await mobile('next')
    expect(html).not.toContain('billing#credits')
    expect(html).not.toContain(ALL.billing)
    expect(html).not.toContain('✦')
  })

  it('keeps every intended bottom-bar destination', async () => {
    const html = await mobile('next')
    for (const href of [ALL.introductions, ALL.network, ALL.messages, ALL.meetings, ALL.profile]) {
      expect(html).toContain(href)
    }
    expect(html).toContain('More')
  })

  it('renders Andrel Next branding', async () => {
    const html = await mobile('next')
    expect(html).toContain('Andrel')
    expect(html).toMatch(/Andrel<\/a>[\s\S]{0,160}>Next</)
  })

  it('hides Opportunities and Billing in the More sheet', () => {
    // Structural: the sheet is behind `showMore`, which a static render never opens, so there is no
    // markup to assert. Both links are wrapped in the same guard the sidebar filter uses.
    const sheet = MOBILE.slice(MOBILE.indexOf('More slide-up menu'), MOBILE.indexOf('Bottom nav'))
    const opp = sheet.slice(sheet.indexOf(`href="${ALL.opportunities}"`) - 200, sheet.indexOf(`href="${ALL.opportunities}"`))
    const bil = sheet.slice(sheet.indexOf(`href="${ALL.billing}"`) - 200, sheet.indexOf(`href="${ALL.billing}"`))
    expect(opp).toContain('{!isNext && (')
    expect(bil).toContain('{!isNext && (')
    // Settings, Admin, Help and Sign out are NOT wrapped — they stay for everyone.
    const settings = sheet.slice(sheet.indexOf(`href="${ALL.settings}"`) - 200, sheet.indexOf(`href="${ALL.settings}"`))
    expect(settings).not.toContain('{!isNext && (')
  })
})

// ═══ 6. MOBILE NAV — PROFESSIONAL, UNCHANGED ══════════════════════════════════════════════════
describe('6. the Professional mobile nav is today\'s mobile nav', () => {
  it('still shows the credits chip', async () => {
    const html = await mobile('professional')
    expect(html).toContain('billing#credits')
    expect(html).toContain('✦ 7')
  })

  it('renders the wordmark as plain Andrel, with NO suffix', async () => {
    const html = await mobile('professional')
    expect(html).toContain('Andrel')
    expect(html).not.toMatch(/Andrel<\/a>[\s\S]{0,160}>Next</)
  })

  it('keeps the whole bottom bar', async () => {
    const html = await mobile('professional')
    for (const href of [ALL.introductions, ALL.network, ALL.messages, ALL.meetings, ALL.profile]) {
      expect(html).toContain(href)
    }
  })

  it('a null credit balance still renders the neutral placeholder, not a zero', async () => {
    const { default: MobileNav } = await import('@/components/MobileNav')
    const React = await import('react')
    const html = await render(React.createElement(MobileNav as any, { ...BASE, credits: null, memberType: 'professional' }))
    expect(html).toContain('✦ —')
  })
})

// ═══ 7. ADMIN IS UNAFFECTED ═══════════════════════════════════════════════════════════════════
describe('7. admin navigation still depends on admin authorization, not on community', () => {
  it('both components gate Admin on the admin check alone', () => {
    for (const src of [SIDEBAR, MOBILE]) {
      expect(src).toMatch(/\{isAdmin && \(/)
      expect(src).toMatch(/setIsAdmin\(user\?\.email === ADMIN_EMAIL\)/)
    }
  })

  it('no admin branch mentions the community', () => {
    for (const src of [SIDEBAR, MOBILE]) {
      const admin = src.slice(src.indexOf('{isAdmin && ('), src.indexOf('{isAdmin && (') + 900)
      expect(admin).not.toMatch(/isNext|memberType|showsNextChrome/)
    }
  })

  it('the admin link is absent from a static render for BOTH communities (isAdmin starts false)', async () => {
    // useEffect does not run under renderToStaticMarkup, so this is the pre-effect state — identical
    // for a professional and a Next member, which is the point: community does not enter into it.
    expect(await sidebar('next')).not.toContain('/dashboard/admin')
    expect(await sidebar('professional')).not.toContain('/dashboard/admin')
  })
})

// ═══ 8. CREDITS: PRESENTATION ONLY ════════════════════════════════════════════════════════════
describe('8. nothing about credits themselves changed', () => {
  it('neither component touches a balance, grant, consumption or subscription rule', () => {
    for (const src of [SIDEBAR, MOBILE]) {
      expect(src).not.toMatch(/meeting_credits|credit_transactions|subscription_tier|stripe/i)
      expect(src).not.toMatch(/\.insert\(|\.update\(|\.upsert\(/)
    }
  })

  it('the CreditsChip component itself is untouched by this step', () => {
    // Still the same three-state chip: null = unavailable, 0 = none remaining, n = a balance.
    expect(SIDEBAR).toMatch(/credits === null\s*\n?\s*\? 'Credits unavailable'/)
    expect(SIDEBAR).toMatch(/function CreditsChip\(\{ credits \}/)
    // ...and it takes no community argument, so it cannot start deciding this for itself.
    expect(SIDEBAR).not.toMatch(/function CreditsChip\([^)]*memberType/)
  })

  it('the layout still passes credits to both components unconditionally', () => {
    const layout = readFileSync('app/dashboard/layout.tsx', 'utf8')
    expect(layout).toMatch(/<MobileNav credits=\{credits\}/)
    expect(layout).toMatch(/credits=\{credits\}/)
    // The server does not stop computing credits for a Next member; only the chrome hides them.
    expect(layout).toMatch(/from\('meeting_credits'\)/)
  })
})

// ═══ 9. THE BOUNDARY IS STILL WHERE STEP 2 PUT IT ═════════════════════════════════════════════
//
// The whole point of shipping Step 2 before Step 3: hiding a link must never become the reason a
// Next member cannot reach a Professional surface. If any of these fails, this step has quietly
// turned presentation into authorization.
describe('9. Step 2 server gates remain the authority, untouched', () => {
  it('the Opportunities page still redirects a Next member server-side', () => {
    const page = readFileSync('app/dashboard/opportunities/page.tsx', 'utf8')
    expect(page).toMatch(/if \(await viewerIsNext\(user\.id\)\) redirect\(NEXT_REDIRECT_TARGET\)/)
    expect(page.indexOf('viewerIsNext(user.id)')).toBeLessThan(page.indexOf('opportunity_candidates'))
  })

  it('the Billing server layout still redirects a Next member', () => {
    const layout = readFileSync('app/dashboard/billing/layout.tsx', 'utf8')
    expect(layout).not.toMatch(/^'use client'/m)
    expect(layout).toMatch(/if \(await viewerIsNext\(user\.id\)\) redirect\(NEXT_REDIRECT_TARGET\)/)
  })

  it('the create and respond APIs still refuse a Next caller', () => {
    for (const name of ['create', 'respond']) {
      const src = readFileSync(`app/api/opportunities/${name}/route.ts`, 'utf8')
      expect(src).toMatch(/if \(await viewerIsNext\(user\.id\)\) \{/)
      expect(src).toMatch(/COMMUNITY_FORBIDDEN, \{ status: COMMUNITY_FORBIDDEN_STATUS \}/)
    }
  })

  it('the authoritative resolver still reads the caller\'s own row through service_role', () => {
    const viewer = readFileSync('lib/community/viewerCommunity.ts', 'utf8')
    expect(viewer).toMatch(/from '@\/lib\/supabase\/admin'/)
    expect(viewer).toMatch(/\.from\('profiles'\)\s*\n\s*\.select\('member_type'\)\s*\n\s*\.eq\('id', userId\)/)
  })

  it('NO gate was rewritten to consult the presentation prop', () => {
    // Asserted against the EXECUTABLE lines. The Billing layout names memberType in prose on
    // purpose — to record that it deliberately does not read it — and a blunt grep would turn that
    // explanation into a failure.
    for (const f of [
      'app/dashboard/opportunities/page.tsx',
      'app/dashboard/billing/layout.tsx',
      'app/api/opportunities/create/route.ts',
      'app/api/opportunities/respond/route.ts',
    ]) {
      const code = readFileSync(f, 'utf8').split('\n')
        .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
        .join('\n')
      expect(code, f).not.toMatch(/communityNav|showsNextChrome|showsNavHref|memberType/)
    }
    // ...and the presentation module is imported by the two nav components and nothing else.
    const { execSync } = require('node:child_process') as typeof import('node:child_process')
    const importers = execSync(
      "grep -rln \"from '@/lib/nav/communityNav'\" --include='*.ts' --include='*.tsx' app lib components 2>/dev/null || true",
      { encoding: 'utf8' },
    ).split('\n').filter(Boolean).filter((f) => !f.includes('__tests__')).sort()
    expect(importers).toEqual(['components/MobileNav.tsx', 'components/Sidebar.tsx'])
  })

  it('the presentation module says, in its own header, that it is not a boundary', () => {
    expect(NAV).toMatch(/PRESENTATION ONLY\. NOT A BOUNDARY\./)
    expect(NAV).toMatch(/deleting every line here\s*\n\/\/ would make two links visible and change nothing/)
  })
})

// ═══ 10. NO CLIENT-SIDE COMMUNITY RESOLUTION ══════════════════════════════════════════════════
describe('10. the browser still cannot look up its own community', () => {
  it('neither component fetches member_type or reaches a resolver', () => {
    for (const src of [SIDEBAR, MOBILE]) {
      expect(src).not.toMatch(/member_type/)
      expect(src).not.toMatch(/resolve_intended_member_type|viewerCommunity|viewerIsNext/)
      expect(src).not.toMatch(/from\('profiles'\)|rpc\(/)
      expect(src).not.toMatch(/localStorage|sessionStorage/)
      // The only supabase call either makes is the pre-existing admin-email check.
      const calls = Array.from(src.matchAll(/supabase\.[a-z]+/g)).map((m) => m[0])
      expect(new Set(calls)).toEqual(new Set(['supabase.auth']))
    }
  })

  it('the presentation module reaches no database at all', () => {
    expect(NAV).not.toMatch(/supabase|createClient|createAdminClient|fetch\(|rpc\(/)
  })

  it('get_my_profile() still does not expose member_type', () => {
    const m057 = readFileSync('supabase/migrations/057_public_profiles_contract_expand.sql', 'utf8')
    const fn = m057.slice(
      m057.indexOf('CREATE OR REPLACE FUNCTION public.get_my_profile()'),
      m057.indexOf('REVOKE ALL ON FUNCTION public.get_my_profile()'),
    )
    expect(fn.length).toBeGreaterThan(100)
    expect(fn).not.toMatch(/member_type/)
  })

  it('community is never inferred from email, school, company, URL or query', () => {
    for (const src of [SIDEBAR, MOBILE, NAV]) {
      expect(src).not.toMatch(/\.edu|law school|lawSchool|company.*next|searchParams/i)
    }
    // The ONE input is the prop, and it arrives already resolved from the server.
    expect(SIDEBAR).toMatch(/memberType = DEFAULT_MEMBER_TYPE,/)
    expect(MOBILE).toMatch(/memberType = DEFAULT_MEMBER_TYPE/)
  })

  it('no migration was added — 100 is still the highest', () => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    const numbers = readdirSync('supabase/migrations')
      .filter((f) => /^\d{3}_.*\.sql$/.test(f))
      .map((f) => Number(f.slice(0, 3)))
    expect(Math.max(...numbers)).toBe(100)
  })
})
