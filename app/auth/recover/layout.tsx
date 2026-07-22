import type { Metadata } from 'next'

/**
 * Metadata for the recovery route. `no-referrer` ensures the page (which may briefly hold a
 * token in the fragment before the client scrub) never sends a Referer to any onward request,
 * and noindex/nofollow keeps it out of search engines. Cache-Control / Referrer-Policy are
 * also set as response headers in next.config.js for defense in depth.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default function RecoverLayout({ children }: { children: React.ReactNode }) {
  return children
}
