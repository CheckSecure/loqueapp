/**
 * THE single source of truth for Andrel's public search identity.
 *
 * Every canonical URL, the sitemap, robots.txt and the JSON-LD graph derive from SITE_ORIGIN, so a
 * domain change is one edit and cannot leave a stale canonical behind pointing at the wrong host.
 *
 * WHY THE ORIGIN IS HARD-CODED rather than read from an env var. A canonical URL that varies by
 * deployment is worse than useless: Vercel preview builds would emit canonicals pointing at
 * *-git-branch.vercel.app, and any preview Google reached would compete with production for the
 * same content. The production origin is a fixed, public fact about this product, so it is a
 * constant. Previews inherit it, which is correct — a preview should point search engines at
 * production, never at itself. (Previews are additionally kept out of the index by the
 * noindex default in app/robots.ts for non-production hosts.)
 *
 * WWW IS PART OF THE ORIGIN. https://www.andrel.app is the canonical host. The apex → www redirect
 * is configured at the domain/DNS layer, outside this repo; nothing here should add a second
 * redirect on top of it, because apex → www → path would be a chain that costs crawl budget and
 * dilutes signals.
 */
export const SITE_ORIGIN = 'https://www.andrel.app' as const
export const SITE_NAME = 'Andrel' as const

/** Absolute canonical URL for a public path. Always exactly one leading slash, never a trailing one. */
export function canonicalUrl(path: string): string {
  if (!path || path === '/') return `${SITE_ORIGIN}/`
  const clean = `/${path.replace(/^\/+/, '').replace(/\/+$/, '')}`
  return `${SITE_ORIGIN}${clean}`
}

/**
 * Paths that are genuinely public marketing surfaces: crawlable, indexable, and safe to list in the
 * sitemap. Everything not on this list is treated as private by default — the sitemap is built FROM
 * this list rather than by walking the route tree, so a new authenticated route can never leak into
 * it by being added to app/.
 *
 * `changeFrequency`/`priority` are hints only; Google ignores them. They are included because other
 * crawlers still read them and they cost nothing.
 */
export const PUBLIC_ROUTES = [
  { path: '/',        changeFrequency: 'weekly'  as const, priority: 1.0 },
  { path: '/about',   changeFrequency: 'monthly' as const, priority: 0.8 },
  { path: '/pricing', changeFrequency: 'monthly' as const, priority: 0.8 },
  { path: '/faq',     changeFrequency: 'monthly' as const, priority: 0.6 },
  { path: '/privacy', changeFrequency: 'yearly'  as const, priority: 0.3 },
  { path: '/terms',   changeFrequency: 'yearly'  as const, priority: 0.3 },
] as const

/**
 * Private HTML routes: every route that must stay OUT of the index but must remain CRAWLABLE.
 *
 * THE DISTINCTION THAT MATTERS, and that an earlier revision of this file got wrong. A crawler can
 * only obey `noindex` on a page it is allowed to FETCH. Disallowing an HTML route in robots.txt
 * therefore does not reinforce its noindex — it destroys it: Googlebot never requests the URL, never
 * sees the directive, and can still list the bare URL in results on the strength of inbound links,
 * with no snippet and no way to remove it. Blocking and noindexing the same HTML URL are mutually
 * exclusive strategies, and noindex is the correct one here. So none of these appear in robots.txt.
 *
 * NEITHER MECHANISM IS ACCESS CONTROL. Both are requests that only well-behaved crawlers honour.
 * What actually keeps member data private is authentication and authorization: middleware.ts gates
 * /dashboard/:path*, and each server component below re-checks `supabase.auth.getUser()` and
 * redirects unauthenticated visitors to /login (itself noindexed). See ROBOTS_DISALLOW for the one
 * category where blocking the crawl is the right call.
 */
export const NOINDEX_PREFIXES = [
  '/dashboard',          // every member surface, incl. /dashboard/admin — auth-gated in middleware
  '/login',
  '/signup',             // redirects to '/' — never a destination of its own
  '/onboarding',         // getUser() -> redirect('/login')
  '/auth',               // callback, forgot-password, recover, reset-password
  '/legal/accept',       // clickwrap, getUser() -> redirect('/login')
  '/manage-information', // nominee privacy page; without a valid token it renders only "link invalid"
  '/company',            // getUser() -> redirect('/login'); names discoverable members
  '/demo',               // a real HTML page (DemoGate), not a redirect — so it needs the same treatment
] as const

/**
 * The only prefixes robots.txt disallows: routes where crawling itself is pointless, because there
 * is no HTML document that could carry a noindex in the first place.
 *
 * /api serves JSON from route handlers. There is no <head>, so `noindex` can only ever be delivered
 * as an X-Robots-Tag header (next.config.js does send one) — but nothing is gained by having a
 * crawler spend budget on endpoints that return no indexable content, and several of them are
 * POST-only or auth-gated. Blocking the crawl costs nothing here precisely because no noindex
 * signal is being suppressed by doing so.
 */
export const ROBOTS_DISALLOW = ['/api'] as const

/** True for a route that must carry noindex. Used by the SEO tests to assert sitemap disjointness. */
export function isNoindexPath(path: string): boolean {
  return NOINDEX_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))
}

/** True for a route robots.txt blocks from being crawled at all. */
export function isCrawlBlockedPath(path: string): boolean {
  return ROBOTS_DISALLOW.some((p) => path === p || path.startsWith(`${p}/`))
}

/**
 * JSON-LD, serialised safely.
 *
 * Everything in the graph below is a STATIC constant from this file — no request data, no member
 * data, no search parameters ever reach it. The `<` escape is belt-and-braces regardless: if any
 * future value did carry `</script>`, this prevents it from closing the tag and injecting markup.
 */
export function jsonLdScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/**
 * WebSite + Organization for the landing page.
 *
 * DELIBERATELY OMITTED, because none of it is verified in this repository and inventing it would be
 * both a Google structured-data violation and a lie: postal address, founding date, employee or
 * member counts, aggregateRating, review, sameAs social profiles, contact phone, and logo.
 *
 * `logo` is omitted specifically because the only brand assets in public/ are two small SVG icon
 * marks (192/512), and Google requires a raster logo of at least 112x112 for Organization. Adding
 * an SVG or a nonexistent path would produce a warning, not a benefit. Supplying a raster logo
 * remains an open operator follow-up; until one exists this field stays absent.
 *
 * `potentialAction`/SearchAction is omitted because Andrel has no public site search endpoint.
 */
export function landingJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${SITE_ORIGIN}/#website`,
        url: `${SITE_ORIGIN}/`,
        name: SITE_NAME,
        description:
          'Andrel is a private professional network connecting executives, legal leaders, and business professionals through curated, mutual introductions.',
        inLanguage: 'en',
        publisher: { '@id': `${SITE_ORIGIN}/#organization` },
      },
      {
        '@type': 'Organization',
        '@id': `${SITE_ORIGIN}/#organization`,
        name: SITE_NAME,
        url: `${SITE_ORIGIN}/`,
        description:
          'A private, invitation-based professional network that creates curated introductions between executives, legal leaders, and business professionals, opened only when both people express interest.',
      },
    ],
  }
}
