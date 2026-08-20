import type { Metadata } from 'next'
import { canonicalUrl, SITE_NAME } from '@/lib/seo/site'

/** /faq is a Client Component (accordion state), so its metadata lives here. */
const TITLE = 'FAQ | How Andrel Introductions Work'
const DESCRIPTION =
  'Answers about how Andrel works: invitations, curated introductions, mutual interest, privacy, and what happens after two members both choose to connect.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: canonicalUrl('/faq') },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    url: canonicalUrl('/faq'),
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: { card: 'summary', title: TITLE, description: DESCRIPTION },
}

export default function FaqLayout({ children }: { children: React.ReactNode }) {
  return children
}
