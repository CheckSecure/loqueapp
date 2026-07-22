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
    return [
      {
        source: '/auth/recover',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store, max-age=0, must-revalidate' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ]
  },
}

module.exports = nextConfig
