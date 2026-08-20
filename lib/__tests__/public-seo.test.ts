import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import robots from '@/app/robots'
import sitemap from '@/app/sitemap'
import {
  SITE_ORIGIN, SITE_NAME, PUBLIC_ROUTES, NOINDEX_PREFIXES, ROBOTS_DISALLOW,
  canonicalUrl, isNoindexPath, isCrawlBlockedPath, jsonLdScript, landingJsonLd,
} from '@/lib/seo/site'

/**
 * Public SEO foundation.
 *
 * WHAT WAS WRONG BEFORE. The landing page had no metadata of its own, so it inherited the root
 * layout's bare "Andrel" title and generic description — the single most valuable page on the site
 * was competing for nothing. There was no robots.txt, no sitemap.xml, no canonical anywhere, and no
 * structured data. /pricing and /faq are Client Components, which cannot export metadata, so they
 * had none at all. Meanwhile /dashboard/**, /login, /onboarding, /auth/**, /manage-information and
 * /company/[slug] carried no noindex: only /auth/recover and /demo did.
 *
 * The load-bearing idea in these tests is that the allow-list is the source of truth. The sitemap is
 * built FROM PUBLIC_ROUTES rather than by walking app/, so a new authenticated route cannot leak in
 * by existing; and every assertion below cross-checks the three artefacts (routes, robots, sitemap)
 * against each other so they cannot drift apart.
 */

const READ = (p: string) => readFileSync(p, 'utf8')
const LANDING = READ('app/page.tsx')
const ABOUT = READ('app/about/page.tsx')
const ROOT_LAYOUT = READ('app/layout.tsx')

describe('canonical origin', () => {
  it('is the www production origin, with no trailing slash', () => {
    expect(SITE_ORIGIN).toBe('https://www.andrel.app')
    expect(SITE_ORIGIN.endsWith('/')).toBe(false)
    expect(SITE_NAME).toBe('Andrel')
  })

  it('builds absolute canonicals without doubled or trailing slashes', () => {
    expect(canonicalUrl('/')).toBe('https://www.andrel.app/')
    expect(canonicalUrl('/about')).toBe('https://www.andrel.app/about')
    expect(canonicalUrl('about')).toBe('https://www.andrel.app/about')
    expect(canonicalUrl('/about/')).toBe('https://www.andrel.app/about')
    expect(canonicalUrl('//about//')).toBe('https://www.andrel.app/about')
  })

  it('never emits an apex URL, which would create an apex -> www redirect chain', () => {
    for (const r of PUBLIC_ROUTES) {
      expect(canonicalUrl(r.path)).not.toMatch(/https:\/\/andrel\.app/)
    }
  })

  it('metadataBase is set so relative URLs never resolve against a preview host', () => {
    expect(ROOT_LAYOUT).toMatch(/metadataBase: new URL\(SITE_ORIGIN\)/)
  })
})

describe('landing page metadata is exactly as approved', () => {
  it('carries the exact required title', () => {
    expect(LANDING).toContain("title: 'Andrel | Curated Executive & Professional Networking'")
  })

  it('carries the exact required description', () => {
    expect(LANDING).toContain(
      'Andrel is a private professional network connecting executives, legal leaders, and business professionals through curated, mutual introductions.',
    )
  })

  it('declares its canonical, and only one', () => {
    expect(LANDING).toContain("alternates: { canonical: canonicalUrl('/') }")
    expect(LANDING.match(/alternates:/g) ?? []).toHaveLength(1)
  })

  it('has Open Graph and Twitter blocks with site name and canonical url', () => {
    expect(LANDING).toMatch(/openGraph: \{[\s\S]*?siteName: SITE_NAME/)
    expect(LANDING).toMatch(/openGraph: \{[\s\S]*?type: 'website'/)
    expect(LANDING).toMatch(/openGraph: \{[\s\S]*?url: canonicalUrl\('\/'\)/)
    expect(LANDING).toMatch(/twitter: \{[\s\S]*?card: 'summary'/)
  })
})

describe('about page metadata is exactly as approved', () => {
  it('carries the exact required title and description', () => {
    expect(ABOUT).toContain("'About Andrel | A Private Executive Networking Platform'")
    expect(ABOUT).toContain(
      'Learn how Andrel creates thoughtful professional relationships through private, curated introductions for executives, legal leaders, and business professionals.',
    )
  })

  it('declares its own canonical', () => {
    expect(ABOUT).toContain("canonical: canonicalUrl('/about')")
  })
})

describe('every indexable public page has unique, complete metadata', () => {
  // route -> file that owns its metadata (a layout for the two Client Component pages)
  const OWNERS: Record<string, string> = {
    '/': 'app/page.tsx',
    '/about': 'app/about/page.tsx',
    '/pricing': 'app/pricing/layout.tsx',
    '/faq': 'app/faq/layout.tsx',
    '/privacy': 'app/privacy/page.tsx',
    '/terms': 'app/terms/page.tsx',
  }

  it('covers exactly the public allow-list', () => {
    expect(Object.keys(OWNERS).sort()).toEqual(PUBLIC_ROUTES.map((r) => r.path).sort())
  })

  // A page may write `title: 'literal'` or hoist it to a constant (`const TITLE = '...'` then
  // `title: TITLE`). Both are valid; resolve either so the assertions test the VALUE, not the style.
  const resolve = (src: string, field: 'title' | 'description'): string | undefined => {
    const inline = src.match(new RegExp(`${field}:\\s*\\n?\\s*'([^']+)'`))?.[1]
    if (inline) return inline
    const ref = src.match(new RegExp(`${field}:\\s*([A-Z_][A-Z0-9_]*)`))?.[1]
    if (!ref) return undefined
    return src.match(new RegExp(`const ${ref}\\s*(?::[^=]+)?=\\s*\\n?\\s*'([^']+)'`))?.[1]
  }

  for (const [route, file] of Object.entries(OWNERS)) {
    it(`${route} declares title, description and canonical`, () => {
      expect(existsSync(file), `${file} missing`).toBe(true)
      const src = READ(file)
      expect(resolve(src, 'title'), `${route} has no resolvable title`).toBeTruthy()
      expect(resolve(src, 'description'), `${route} has no resolvable description`).toBeTruthy()
      expect(src, `${route} has no canonical`).toContain('canonical: canonicalUrl(')
    })
  }

  it('titles and descriptions are unique across public pages', () => {
    const titles = new Set<string>()
    const descs = new Set<string>()
    for (const file of Object.values(OWNERS)) {
      const src = READ(file)
      const t = resolve(src, 'title') as string
      const d = resolve(src, 'description') as string
      expect(t, `${file}: no parseable title`).toBeTruthy()
      expect(titles.has(t), `duplicate title: ${t}`).toBe(false)
      titles.add(t)
      expect(d, `${file}: no parseable description`).toBeTruthy()
      expect(descs.has(d), `duplicate description in ${file}`).toBe(false)
      descs.add(d)
    }
    expect(titles.size).toBe(6)
    expect(descs.size).toBe(6)
  })

  it('the Client Component pages get their metadata from a server layout', () => {
    // /pricing and /faq are 'use client' — a Client Component cannot export metadata at all, which
    // is why they previously had none.
    for (const p of ['app/pricing/page.tsx', 'app/faq/page.tsx']) {
      expect(READ(p).split('\n').slice(0, 3).join('\n')).toMatch(/'use client'/)
    }
    for (const l of ['app/pricing/layout.tsx', 'app/faq/layout.tsx']) {
      expect(READ(l)).not.toMatch(/'use client'/)
      expect(READ(l)).toMatch(/export const metadata/)
    }
  })
})

describe('sitemap contains only canonical public pages', () => {
  const entries = sitemap()

  it('lists exactly the public allow-list, as absolute www URLs', () => {
    expect(entries.map((e) => e.url).sort()).toEqual(PUBLIC_ROUTES.map((r) => canonicalUrl(r.path)).sort())
    for (const e of entries) expect(e.url.startsWith('https://www.andrel.app')).toBe(true)
  })

  it('contains NO private route, checked prefix by prefix', () => {
    for (const e of entries) {
      const path = e.url.replace(SITE_ORIGIN, '') || '/'
      expect(isNoindexPath(path), `${e.url} is private`).toBe(false)
    }
  })

  it('names none of the sensitive areas anywhere in its output', () => {
    const blob = JSON.stringify(entries)
    for (const bad of [
      'dashboard', 'admin', 'login', 'signup', 'onboarding', '/auth', 'reset-password',
      'recover', 'forgot-password', 'verify-email', 'manage-information', 'invitation',
      'token', '/api/', '/company/', 'profile', 'demo', 'legal/accept',
    ]) {
      expect(blob.toLowerCase(), `sitemap leaks ${bad}`).not.toContain(bad.toLowerCase())
    }
  })

  it('exposes no member identifier — no uuid, email or name', () => {
    const blob = JSON.stringify(entries)
    expect(blob).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    expect(blob).not.toMatch(/[\w.+-]+@[\w.-]+\.\w+/)
  })

  it('has no duplicate URLs', () => {
    const urls = entries.map((e) => e.url)
    expect(new Set(urls).size).toBe(urls.length)
  })
})

describe('robots configuration', () => {
  const r = robots()
  const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules
  const disallow = (rule?.disallow ?? []) as string[]

  it('references the canonical sitemap on the www origin', () => {
    expect(r.sitemap).toBe('https://www.andrel.app/sitemap.xml')
  })

  it('emits NO host directive', () => {
    // `Host:` is a nonstandard Yandex extension Google has never supported. Canonical host is
    // established by rel=canonical, the apex -> www redirect, sitemap URLs and internal links.
    expect(r.host).toBeUndefined()
  })

  it('allows public crawling', () => {
    expect(rule?.allow).toBe('/')
    expect(rule?.userAgent).toBe('*')
  })

  it('disallows ONLY /api — nothing else', () => {
    expect(disallow).toEqual(['/api'])
    expect([...ROBOTS_DISALLOW]).toEqual(['/api'])
  })

  it('does not block any private HTML route, because that would hide its noindex', () => {
    // THE CORRECTION THIS TEST EXISTS FOR. A crawler can only honour `noindex` on a page it is
    // permitted to fetch. Disallowing /login or /dashboard would stop Googlebot requesting them,
    // so it would never see their noindex, and the URLs could still be listed from inbound links.
    for (const p of NOINDEX_PREFIXES) {
      expect(disallow, `${p} is noindexed and must stay crawlable so the directive is observable`)
        .not.toContain(p)
      expect(disallow, `${p}/ must not be blocked either`).not.toContain(`${p}/`)
    }
    for (const p of ['/login', '/dashboard', '/onboarding', '/auth', '/signup', '/demo',
                     '/legal/accept', '/manage-information', '/company']) {
      expect(isCrawlBlockedPath(p), `${p} must not be crawl-blocked`).toBe(false)
    }
  })

  it('/api is crawl-blocked and carries no HTML that a noindex could live in', () => {
    expect(isCrawlBlockedPath('/api')).toBe(true)
    expect(isCrawlBlockedPath('/api/admin/companies/merge')).toBe(true)
    // and it is not in the HTML noindex list, since there is no document to put a meta tag on
    expect([...NOINDEX_PREFIXES]).not.toContain('/api')
  })

  it('the two lists are disjoint — a path is crawl-blocked or noindexed, never both', () => {
    for (const p of NOINDEX_PREFIXES) expect(isCrawlBlockedPath(p), `${p} in both lists`).toBe(false)
    for (const p of ROBOTS_DISALLOW) expect(isNoindexPath(p), `${p} in both lists`).toBe(false)
  })

  it('does not disallow any public route', () => {
    for (const pub of PUBLIC_ROUTES) {
      for (const d of disallow) {
        const prefix = d.replace(/\/$/, '')
        expect(pub.path === prefix || pub.path.startsWith(`${prefix}/`), `${pub.path} blocked by ${d}`).toBe(false)
      }
    }
  })

  it('every public route is crawlable and none is noindexed', () => {
    for (const pub of PUBLIC_ROUTES) {
      expect(isCrawlBlockedPath(pub.path), `${pub.path} crawl-blocked`).toBe(false)
      expect(isNoindexPath(pub.path), `${pub.path} noindexed`).toBe(false)
    }
  })
})

describe('private HTML surfaces are noindex, and stay fetchable so it is seen', () => {
  const LAYOUTS = [
    'app/dashboard/layout.tsx',
    'app/login/layout.tsx',
    'app/onboarding/layout.tsx',
    'app/auth/layout.tsx',
    'app/auth/recover/layout.tsx',
    'app/signup/layout.tsx',
    'app/legal/layout.tsx',
    'app/manage-information/layout.tsx',
    'app/company/layout.tsx',
  ]

  for (const f of LAYOUTS) {
    it(`${f.replace('app/', '').replace('/layout.tsx', '')} sets robots index:false, follow:false`, () => {
      expect(existsSync(f), `${f} missing`).toBe(true)
      expect(READ(f)).toMatch(/robots: \{[^}]*index: false/)
      expect(READ(f)).toMatch(/robots: \{[^}]*follow: false/)
    })
  }

  it('/demo keeps its own pre-existing noindex — it is a real page, not a redirect', () => {
    const demo = READ('app/demo/page.tsx')
    expect(demo).toMatch(/robots: \{ index: false/)
    expect(demo).toMatch(/export default function DemoPage/)  // renders HTML, so noindex is observable
  })

  it('every noindex prefix has a metadata source that declares it', () => {
    const sources: Record<string, string> = {
      '/dashboard': 'app/dashboard/layout.tsx',
      '/login': 'app/login/layout.tsx',
      '/signup': 'app/signup/layout.tsx',
      '/onboarding': 'app/onboarding/layout.tsx',
      '/auth': 'app/auth/layout.tsx',
      '/legal/accept': 'app/legal/layout.tsx',
      '/manage-information': 'app/manage-information/layout.tsx',
      '/company': 'app/company/layout.tsx',
      '/demo': 'app/demo/page.tsx',
    }
    for (const p of NOINDEX_PREFIXES) {
      const f = sources[p]
      expect(f, `no metadata source mapped for ${p}`).toBeTruthy()
      expect(READ(f)).toMatch(/index: false/)
    }
  })

  it('unauthenticated visitors are redirected to /login, which is itself noindexed', () => {
    // Auth, not robots, is the privacy boundary. Each gated server component re-checks getUser().
    for (const f of ['app/onboarding/page.tsx', 'app/legal/accept/page.tsx', 'app/company/[slug]/page.tsx',
                     'app/dashboard/layout.tsx']) {
      const src = READ(f)
      // either the direct call or the React-cached getAuthUser() wrapper the dashboard uses
      expect(src, `${f} does not verify the user`).toMatch(/auth\.getUser\(\)|getAuthUser\(\)/)
      expect(src, `${f} does not gate on a missing user`).toMatch(/if \(!user\) redirect\('\/login'\)/)
    }
    expect(READ('app/login/layout.tsx')).toMatch(/index: false/)
  })

  it('/manage-information without a valid token exposes no member content', () => {
    const src = READ('app/manage-information/page.tsx')
    expect(src).toMatch(/verifyManageToken\(token\)/)
    expect(src).toMatch(/This link is invalid or has expired/)
  })

  it('the auth gate is untouched — middleware still protects /dashboard', () => {
    const mw = READ('middleware.ts')
    expect(mw).toContain("matcher: ['/dashboard/:path*']")
    expect(mw).toMatch(/redirect\(new URL\('\/login'/)
  })

  it('X-Robots-Tag headers back the metadata on every noindex prefix, plus /api', () => {
    const cfg = READ('next.config.js')
    expect(cfg).toMatch(/X-Robots-Tag'?, value: 'noindex, nofollow'/)
    for (const p of ['/dashboard/:path*', '/api/:path*', '/login', '/signup', '/onboarding/:path*',
                     '/auth/:path*', '/legal/:path*', '/company/:path*', '/manage-information', '/demo']) {
      expect(cfg, `no header rule for ${p}`).toContain(`'${p}'`)
    }
  })
})

describe('structured data', () => {
  const ld = landingJsonLd()
  const graph = ld['@graph'] as Array<Record<string, unknown>>

  it('declares exactly WebSite and Organization', () => {
    expect(ld['@context']).toBe('https://schema.org')
    expect(graph.map((n) => n['@type']).sort()).toEqual(['Organization', 'WebSite'])
  })

  it('uses canonical www URLs and links WebSite to its publisher', () => {
    const site = graph.find((n) => n['@type'] === 'WebSite') as any
    const org = graph.find((n) => n['@type'] === 'Organization') as any
    expect(site.url).toBe('https://www.andrel.app/')
    expect(org.url).toBe('https://www.andrel.app/')
    expect(site.publisher['@id']).toBe(org['@id'])
  })

  it('fabricates nothing — no address, rating, review, counts, socials or founding date', () => {
    const blob = JSON.stringify(ld).toLowerCase()
    for (const forbidden of [
      'aggregaterating', 'review', 'ratingvalue', 'address', 'postaladdress', 'telephone',
      'foundingdate', 'numberofemployees', 'membercount', 'sameas', 'price', 'offer', 'logo',
    ]) {
      expect(blob, `JSON-LD contains unverified field: ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('carries no member data or identifiers', () => {
    const blob = JSON.stringify(ld)
    expect(blob).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    expect(blob).not.toMatch(/[\w.+-]+@[\w.-]+\.\w+/)
  })

  it('serialises safely: a script-closing sequence cannot escape the tag', () => {
    expect(jsonLdScript({ x: '</script><img onerror=alert(1)>' })).not.toContain('</script>')
    expect(jsonLdScript({ x: '</script>' })).toContain('\\u003c')
    // and the real payload round-trips to valid JSON
    expect(() => JSON.parse(jsonLdScript(ld).replace(/\\u003c/g, '<'))).not.toThrow()
  })

  it('is emitted on the landing page only', () => {
    expect(LANDING).toContain('application/ld+json')
    expect(LANDING).toContain('jsonLdScript(landingJsonLd())')
    expect(ABOUT).not.toContain('application/ld+json')
  })
})

describe('claims and hygiene', () => {
  const PUBLIC_FILES = [
    'app/page.tsx', 'app/about/page.tsx', 'app/pricing/page.tsx', 'app/faq/page.tsx',
    'app/pricing/layout.tsx', 'app/faq/layout.tsx', 'app/layout.tsx', 'lib/seo/site.ts',
  ]

  it('makes no superiority or affiliation claim about LinkedIn', () => {
    for (const f of PUBLIC_FILES) {
      const src = READ(f).toLowerCase()
      expect(src, `${f}`).not.toContain('better than linkedin')
      expect(src, `${f}`).not.toMatch(/partnered with linkedin|affiliated with linkedin|official linkedin/)
    }
  })

  it('adds no meta keywords tag — Google ignores it', () => {
    for (const f of [...PUBLIC_FILES, 'app/privacy/page.tsx', 'app/terms/page.tsx']) {
      expect(READ(f), f).not.toMatch(/keywords:/)
      expect(READ(f), f).not.toMatch(/name="keywords"/)
    }
  })

  it('the landing page still has exactly one H1 and a logical heading order', () => {
    expect((LANDING.match(/<h1/g) ?? []).length).toBe(1)
    expect((LANDING.match(/<h2/g) ?? []).length).toBeGreaterThan(0)
    const firstH1 = LANDING.indexOf('<h1')
    const firstH2 = LANDING.indexOf('<h2')
    expect(firstH1).toBeLessThan(firstH2)   // H1 precedes the first H2
  })

  it('About and the public pages each have exactly one H1', () => {
    for (const f of ['app/about/page.tsx', 'app/pricing/page.tsx', 'app/faq/page.tsx',
                     'app/privacy/page.tsx', 'app/terms/page.tsx']) {
      expect((READ(f).match(/<h1/g) ?? []).length, f).toBe(1)
    }
  })

  it('Home, About and Pricing link to one another descriptively', () => {
    expect(LANDING).toMatch(/href="\/about"/)
    expect(LANDING).toMatch(/href="\/pricing"/)
    expect(ABOUT).toMatch(/href="\//)
  })

  it('preserves the invitation-only, mutual-interest and free-tier positioning', () => {
    const landing = LANDING.toLowerCase()
    expect(landing).toContain('invite-only')
    expect(READ('app/pricing/layout.tsx').toLowerCase()).toContain('free to join')
    expect(ABOUT.toLowerCase()).toMatch(/mutual|both/)
  })

  it('references no social image file that does not exist', () => {
    for (const f of PUBLIC_FILES) {
      const refs = READ(f).match(/['"]\/[\w./-]+\.(png|jpg|jpeg|webp|svg)['"]/g) ?? []
      for (const ref of refs) {
        const rel = ref.slice(1, -1)
        expect(existsSync(`public${rel}`), `${f} references missing asset ${rel}`).toBe(true)
      }
    }
  })
})
