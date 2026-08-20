import type { Metadata } from 'next'

/**
 * NOINDEX. Callback, forgot-password, recover and reset-password. /auth/recover additionally sets no-referrer and an X-Robots-Tag header.
 *
 * This route is deliberately NOT disallowed in robots.txt. A crawler can only obey `noindex` on a
 * page it is permitted to fetch, so blocking the URL would hide this very directive and leave the
 * page indexable-by-reference from any inbound link. Staying crawlable is what makes the exclusion
 * work. The auth gate, not either robots mechanism, remains the real protection.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
}

export default function NoIndexLayout({ children }: { children: React.ReactNode }) {
  return children
}
