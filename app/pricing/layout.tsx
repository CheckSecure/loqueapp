import type { Metadata } from 'next'
import { canonicalUrl, SITE_NAME } from '@/lib/seo/site'

/**
 * app/pricing/page.tsx is a Client Component (it holds the monthly/annual toggle), and a Client
 * Component cannot export `metadata`. This server layout supplies it — the standard Next pattern,
 * and the reason /pricing previously had no description or canonical at all.
 *
 * The copy describes only what the page actually renders: a free tier and two optional paid tiers.
 * No price is repeated here, so this cannot drift out of sync with the tiers on the page.
 */
const TITLE = 'Pricing | Andrel Membership Plans'
const DESCRIPTION =
  'Andrel membership is free to join, with optional paid plans for members who want more introduction credits each month.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: canonicalUrl('/pricing') },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    url: canonicalUrl('/pricing'),
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: { card: 'summary', title: TITLE, description: DESCRIPTION },
}

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return children
}
