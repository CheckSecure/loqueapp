import type { MetadataRoute } from 'next'
import { PUBLIC_ROUTES, canonicalUrl } from '@/lib/seo/site'

/**
 * sitemap.xml.
 *
 * Built from the explicit PUBLIC_ROUTES allow-list, NOT by walking app/. That direction matters: a
 * generated sitemap that enumerates routes would silently start advertising every new authenticated
 * page someone adds. This way a private route cannot leak in by accident — it has to be typed into
 * the allow-list deliberately, and the SEO tests assert nothing in it matches a private prefix.
 *
 * Every URL is absolute, on the canonical www origin, and identical to the `alternates.canonical`
 * each page declares — a sitemap URL that disagrees with the page's own canonical is a conflicting
 * signal, so both derive from canonicalUrl().
 *
 * lastModified is deliberately omitted rather than stamped with build time: a date that changes on
 * every unrelated deploy is noise, and Google treats an obviously-automatic lastModified as
 * untrustworthy.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_ROUTES.map((r) => ({
    url: canonicalUrl(r.path),
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }))
}
