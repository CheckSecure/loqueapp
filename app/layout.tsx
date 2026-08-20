import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { SITE_ORIGIN, SITE_NAME } from '@/lib/seo/site'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  // metadataBase makes every relative canonical/OG URL in the app resolve against the canonical
  // production origin. Without it Next resolves them against the deploy host, so preview builds
  // would emit canonicals pointing at themselves.
  metadataBase: new URL(SITE_ORIGIN),
  // NO title template. The landing and About titles are contractually exact strings; a template
  // would append a suffix to them. Each page therefore states its own complete title.
  title: SITE_NAME,
  description:
    'Andrel is a private professional network connecting executives, legal leaders, and business professionals through curated, mutual introductions.',
  applicationName: SITE_NAME,
  // Default for anything that does not set its own. Public marketing pages opt IN to indexing
  // explicitly; every private surface either inherits a noindex layout or sets its own.
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    locale: 'en_US',
    url: `${SITE_ORIGIN}/`,
  },
  twitter: { card: 'summary' },
  manifest: '/manifest.json',
  themeColor: '#1B2850',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Andrel',
  },
  icons: {
    icon: '/icons/icon-192.svg',
    apple: '/icons/icon-192.svg',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#1B2850" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Andrel" />
        <link rel="apple-touch-icon" href="/icons/icon-192.svg" />
      </head>
      <body className={`${inter.className} overflow-x-hidden`}>{children}</body>
    </html>
  )
}
