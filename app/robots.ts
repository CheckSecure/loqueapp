import type { MetadataRoute } from 'next'
import { SITE_ORIGIN, ROBOTS_DISALLOW } from '@/lib/seo/site'

/**
 * robots.txt — deliberately minimal.
 *
 * WHY THE PRIVATE HTML ROUTES ARE NOT LISTED HERE. They are not an oversight. Google must be able
 * to FETCH an HTML URL to observe the `noindex` on it. Disallowing /login or /dashboard would stop
 * Googlebot from ever requesting them, so it would never see their noindex — and a blocked URL can
 * still be listed from inbound links, as a bare URL with no snippet, which is harder to get removed
 * than a page that was crawled and correctly excluded. Blocking and noindexing the same HTML URL
 * are mutually exclusive; noindex is the right choice for those routes, so robots.txt stays out of
 * their way. Their protection is route/layout metadata + X-Robots-Tag + the auth gate.
 *
 * Only ROBOTS_DISALLOW is listed: /api, which returns JSON rather than an indexable document, so
 * disallowing it suppresses no noindex signal and simply saves crawl budget.
 *
 * NO `host` DIRECTIVE. It is a nonstandard field that Google has never supported (it was a Yandex
 * extension). www.andrel.app is established as canonical the ways that actually work: the rel=
 * canonical tag on every public page, the apex -> www redirect, absolute www URLs in the sitemap,
 * and consistent internal linking.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // Prefix match, no trailing slash: '/api' covers /api and /api/anything.
        disallow: [...ROBOTS_DISALLOW],
      },
    ],
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
  }
}
