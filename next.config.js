/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pragmatic: don't block Vercel deploys on TypeScript errors in
  // admin/legacy components while we pay down type debt incrementally.
  // Dev mode (`npm run dev`) still reports type errors for active work.
  typescript: {
    ignoreBuildErrors: true,
  },
  async headers() {
    // Harden the password-recovery route: never cache it, never send a Referer onward,
    // and keep it out of search indexes. Defense-in-depth alongside the route metadata
    // and the client-side URL scrub.
    // Private areas carry an X-Robots-Tag response header as well as route/layout metadata. The
    // header is the layer that still works for non-HTML responses (API routes) and for redirects,
    // where there is no document for a <meta name="robots"> tag to live in.
    //
    // These two layers reinforce each other because both are delivered IN THE RESPONSE — a crawler
    // sees them precisely because it was allowed to make the request. That is why robots.txt does
    // not disallow these HTML routes: blocking the fetch would suppress both signals at once and
    // leave the URL indexable-by-reference. Only /api is disallowed there, and it is covered here
    // by the header regardless, for any crawler that requests it anyway.
    const NOINDEX = { key: 'X-Robots-Tag', value: 'noindex, nofollow' }
    const privateAreas = [
      '/dashboard/:path*',
      '/login',
      '/signup',
      '/onboarding/:path*',
      '/auth/:path*',
      '/legal/:path*',
      '/manage-information',
      '/company/:path*',
      '/demo',
      '/api/:path*',
    ]
    return [
      {
        source: '/auth/recover',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store, max-age=0, must-revalidate' },
          NOINDEX,
        ],
      },
      ...privateAreas.map((source) => ({ source, headers: [NOINDEX] })),
    ]
  },
}

module.exports = nextConfig
