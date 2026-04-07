import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Andrel',
  description: 'Andrel — Curated professional introductions for people worth knowing.',
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
