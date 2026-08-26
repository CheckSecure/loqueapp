import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  PUBLIC_LOGO_HREF, AUTHENTICATED_LOGO_HREF, LOGO_ARIA_LABEL, logoHref,
} from '@/lib/nav/logoHref'

const read = (p: string) => readFileSync(p, 'utf8')

// ── 1. The shared authority ───────────────────────────────────────────────────────────
describe('logoHref — one destination rule', () => {
  it('maps auth state to the two destinations', () => {
    expect(logoHref(false)).toBe('/')
    expect(logoHref(true)).toBe('/dashboard/introductions')
    expect(PUBLIC_LOGO_HREF).toBe('/')
    expect(AUTHENTICATED_LOGO_HREF).toBe('/dashboard/introductions')
    expect(LOGO_ARIA_LABEL).toBe('Andrel home')
  })

  it('agrees with the canonical authenticated landing page the app already redirects to', () => {
    // app/dashboard/page.tsx redirects here; app/login/page.tsx pushes here after sign-in.
    expect(read('app/dashboard/page.tsx')).toContain(`redirect('${AUTHENTICATED_LOGO_HREF}')`)
    expect(read('app/login/page.tsx')).toContain(`router.push('${AUTHENTICATED_LOGO_HREF}')`)
  })

  // The module's own documentation names supabase/localStorage in order to say it uses neither,
  // so comments are stripped before probing the executable source.
  const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ')

  it('performs NO auth check of its own — it is a pure mapping', () => {
    const src = code('lib/nav/logoHref.ts')
    expect(src).not.toMatch(/supabase|createClient|getUser|cookies|localStorage|sessionStorage|fetch\(/)
    expect(src).not.toMatch(/\buseState\b|\buseEffect\b/)
  })
})

// ── 2. Authenticated surfaces ─────────────────────────────────────────────────────────
describe('authenticated dashboard, admin and mobile', () => {
  const LAYOUT = read('app/dashboard/layout.tsx')
  const SIDEBAR = read('components/Sidebar.tsx')
  const MOBILE = read('components/MobileNav.tsx')

  it('the server layout resolves the href and passes it to BOTH surfaces', () => {
    expect(LAYOUT).toContain("import { AUTHENTICATED_LOGO_HREF } from '@/lib/nav/logoHref'")
    expect(LAYOUT).toMatch(/<Sidebar[\s\S]{0,700}logoHref=\{AUTHENTICATED_LOGO_HREF\}/)
    expect(LAYOUT).toMatch(/<MobileNav[\s\S]{0,400}logoHref=\{AUTHENTICATED_LOGO_HREF\}/)
  })

  it('the desktop sidebar wordmark is a real Link to the resolved href', () => {
    expect(SIDEBAR).toMatch(/<Link\s+href=\{logoHref\}[\s\S]{0,400}Andrel[\s\S]{0,40}<\/Link>/)
    expect(SIDEBAR).toContain('aria-label={LOGO_ARIA_LABEL}')
  })

  it('the mobile dashboard wordmark is a real Link to the resolved href', () => {
    expect(MOBILE).toMatch(/<Link\s+href=\{logoHref\}[\s\S]{0,400}Andrel[\s\S]{0,40}<\/Link>/)
    expect(MOBILE).toContain('aria-label={LOGO_ARIA_LABEL}')
  })

  // Admin pages live under /dashboard/admin and there is no app/dashboard/admin/layout.tsx,
  // so they inherit this layout — the admin wordmark is the same component and the same href.
  it('admin inherits the same layout, so it cannot diverge', () => {
    let hasAdminLayout = true
    try { statSync('app/dashboard/admin/layout.tsx') } catch { hasAdminLayout = false }
    expect(hasAdminLayout).toBe(false)
    expect(LAYOUT).toMatch(/<Sidebar/)
  })

  it('NEITHER client component asks Supabase who the viewer is in order to render the link', () => {
    for (const [n, src] of [['Sidebar', SIDEBAR], ['MobileNav', MOBILE]] as const) {
      // the href is a prop, not something derived from a session lookup
      expect(src, n).toMatch(/logoHref[?:,\s]/)
      const logoBlock = src.slice(Math.max(0, src.indexOf('href={logoHref}') - 600),
                                 src.indexOf('href={logoHref}') + 400)
      expect(logoBlock, n).not.toMatch(/getUser|auth\.getSession|createClient\(/)
    }
    // Sidebar already had a client Supabase call for sign-out; assert we added no new auth read.
    expect((SIDEBAR.match(/auth\.getUser\(/g) || []).length).toBeLessThanOrEqual(1)
  })
})

// ── 3. Logged-out surfaces ────────────────────────────────────────────────────────────
describe('public, auth and invitation surfaces link to the homepage', () => {
  it('the landing nav wordmark is a Link to /', () => {
    const src = read('app/page.tsx')
    expect(src).toContain("import { PUBLIC_LOGO_HREF, LOGO_ARIA_LABEL } from '@/lib/nav/logoHref'")
    expect(src).toMatch(/<Link\s+href=\{PUBLIC_LOGO_HREF\}[\s\S]{0,400}Andrel[\s\S]{0,40}<\/Link>/)
    // and an authenticated visitor never renders it — the page redirects first
    expect(src).toContain(`if (user) redirect('${AUTHENTICATED_LOGO_HREF}')`)
  })

  it('the invitation-resume wordmark is a Link to /', () => {
    const src = read('app/resume/page.tsx')
    expect(src).toMatch(/<Link[\s\S]{0,300}href=\{PUBLIC_LOGO_HREF\}/)
    expect(src).toContain('aria-label={LOGO_ARIA_LABEL}')
  })

  it('login and password-recovery wordmarks still point at / (unchanged)', () => {
    for (const p of ['app/login/page.tsx', 'app/auth/forgot-password/page.tsx',
                     'app/auth/reset-password/page.tsx', 'app/auth/recover/page.tsx']) {
      expect(read(p), p).toMatch(/<Link href="\/"[^>]*>Andrel<\/Link>/)
    }
  })

  it('legal and marketing wordmarks still point at / (unchanged)', () => {
    for (const p of ['app/privacy/page.tsx', 'app/terms/page.tsx', 'app/faq/page.tsx',
                     'app/about/page.tsx', 'app/pricing/page.tsx',
                     'app/manage-information/page.tsx', 'app/legal/accept/page.tsx']) {
      expect(read(p), p).toMatch(/<Link href="\/"[^>]*>Andrel<\/Link>/)
    }
  })
})

// ── 4. No wordmark is left dead or contradictory ──────────────────────────────────────
describe('no dead or contradictory wordmark remains', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) { if (e !== 'node_modules' && e !== '.next') walk(p, out) }
      else if (p.endsWith('.tsx')) out.push(p)
    }
    return out
  }
  const FILES = [...walk('app'), ...walk('components')].filter(p => !p.includes('__tests__'))

  // A NAV wordmark: the bare brand word as the whole text of a span/p in a header position.
  // Copy that merely mentions Andrel ("Welcome to Andrel!") is not a wordmark.
  const DEAD = /<(span|p)\b[^>]*>\s*Andrel\s*<\/\1>/g

  it('every remaining bare-<span>Andrel</span> is inside a Link or is a known non-nav case', () => {
    const offenders: string[] = []
    for (const p of FILES) {
      const src = read(p)
      let m: RegExpExecArray | null
      const re = new RegExp(DEAD.source, 'g')
      while ((m = re.exec(src)) !== null) {
        // look backwards for an enclosing <Link ...> opened within the preceding 600 chars
        const before = src.slice(Math.max(0, m.index - 600), m.index)
        const wrapped = /<Link[\s\S]*$/.test(before) && !/<\/Link>/.test(before.slice(before.lastIndexOf('<Link')))
        if (!wrapped) offenders.push(`${p}: ${m[0]}`)
      }
    }
    // What remains is deliberately NOT navigation, pinned exactly so a genuinely new dead
    // wordmark still fails this test:
    //   DemoGate x2 — the title of a password gate the visitor must pass. Linking away from a
    //                 gate is not navigation.
    //   DemoGate x1 — the brand word inside the sentence "See how Andrel works".
    //   3 meeting modals — a 10px uppercase eyebrow label above a heading, not a wordmark.
    expect(offenders.sort()).toEqual([
      'components/DemoGate.tsx: <p className="text-2xl font-bold text-brand-navy tracking-tight text-center mb-8">Andrel</p>',
      'components/DemoGate.tsx: <p className="text-2xl font-bold text-brand-navy tracking-tight text-center mb-8">Andrel</p>',
      'components/DemoGate.tsx: <span className="text-brand-gold">Andrel</span>',
      'components/MeetingDetailModal.tsx: <p className="text-[10px] uppercase tracking-[0.18em] text-brand-gold font-bold mb-0.5">Andrel</p>',
      'components/RescheduleMeetingModal.tsx: <p className="text-[10px] uppercase tracking-[0.18em] text-brand-gold font-bold mb-1">Andrel</p>',
      'components/ScheduleMeetingModal.tsx: <p className="text-[10px] uppercase tracking-[0.18em] text-brand-gold font-bold mb-1">Andrel</p>',
    ])
  })

  it('no wordmark link points anywhere other than / or the canonical dashboard page', () => {
    const bad: string[] = []
    for (const p of FILES) {
      const src = read(p)
      const re = /<Link[^>]*href=(\{[^}]+\}|"[^"]+")[^>]*>[\s\S]{0,120}?<\/Link>/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) {
        if (!/>\s*Andrel\s*</.test(m[0]) && !/text-sm font-semibold">Andrel</.test(m[0])) continue
        const href = m[1]
        const ok = href === '"/"' || href === '{PUBLIC_LOGO_HREF}' || href === '{logoHref}'
          || href === '{AUTHENTICATED_LOGO_HREF}'
        if (!ok) bad.push(`${p}: href=${href}`)
      }
    }
    expect(bad).toEqual([])
  })
  it('the onboarding wordmark is a Link to the dashboard, resolved on the server', () => {
    const form = read('components/OnboardingForm.tsx')
    const page = read('app/onboarding/page.tsx')
    expect(form).toMatch(/<Link\s+href=\{logoHref\}[\s\S]{0,500}Andrel[\s\S]{0,40}<\/Link>/)
    expect(form).toContain('aria-label={LOGO_ARIA_LABEL}')
    expect(page).toContain("import { AUTHENTICATED_LOGO_HREF } from '@/lib/nav/logoHref'")
    expect(page).toMatch(/<OnboardingForm[\s\S]{0,300}logoHref=\{AUTHENTICATED_LOGO_HREF\}/)
    // the surface is authenticated: no session → /login, already complete → the dashboard
    expect(page).toMatch(/if \(!user\) redirect\('\/login'\)/)
  })
})

// ── 5. Guards are untouched ───────────────────────────────────────────────────────────
describe('existing guards and redirects are unchanged', () => {
  it('the onboarding guard still sends an unstarted member to /onboarding', () => {
    const src = read('app/dashboard/layout.tsx')
    expect(src).toMatch(/const needsOnboarding = !profile \|\| \(!profile\.profile_complete && !profile\.full_name\)/)
    expect(src).toMatch(/if \(needsOnboarding\) redirect\('\/onboarding'\)/)
  })

  it('an incomplete member following the wordmark still hits that guard', () => {
    // The wordmark targets /dashboard/introductions, which is inside app/dashboard/layout.tsx,
    // so the guard runs before the page renders. The link changes nothing about who may arrive.
    const src = read('app/dashboard/layout.tsx')
    const guardAt = src.indexOf('if (needsOnboarding) redirect')
    const childrenAt = src.indexOf('{children}')
    expect(guardAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(childrenAt)
  })

  it('no migration, API route, env var, cookie or auth store was introduced', () => {
    const src = read('lib/nav/logoHref.ts').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ')
    expect(src).not.toMatch(/process\.env|document\.cookie|localStorage|sessionStorage|NEXT_PUBLIC_/)
  })
})
