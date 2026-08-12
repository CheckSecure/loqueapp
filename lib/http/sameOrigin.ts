import { NextResponse } from 'next/server'

/**
 * Minimal same-origin guard for state-changing, cookie-authenticated API routes (CSRF mitigation).
 *
 * Cookie-based admin auth (requireAdmin) is vulnerable to cross-site request forgery: a page on
 * another origin could POST with the victim's session cookie. This check rejects such requests using
 * ONLY standard request headers — no token framework, no new dependency. Returns a 403 NextResponse
 * to return directly, or null when the request is same-origin.
 *
 * Layered signals (FAIL CLOSED):
 *  - Both Sec-Fetch-Site AND Origin absent → rejected. A modern browser mutation always sends at
 *    least Sec-Fetch-Site; a request carrying neither cannot be proven same-origin.
 *  - Sec-Fetch-Site present: only 'same-origin' / 'same-site' / 'none' pass; a cross-site forged
 *    POST carries 'cross-site' and is rejected.
 *  - Origin present: its host MUST equal the request Host (the Vercel-set Host header — NOT any
 *    client-supplied x-forwarded-host). A spoofed/mismatched Origin/Host is rejected. A CSRF from
 *    another site carries that site's real Origin (browsers set it honestly), so this blocks it.
 */
export function assertSameOrigin(req: Request): NextResponse | null {
  const reject = (msg = 'Cross-origin request rejected') => NextResponse.json({ error: msg }, { status: 403 })

  const secFetchSite = req.headers.get('sec-fetch-site')
  const origin = req.headers.get('origin')

  // Fail closed: a browser-style mutation with NO same-origin signal at all.
  if (!secFetchSite && !origin) return reject('Missing same-origin signal')

  if (secFetchSite && !['same-origin', 'same-site', 'none'].includes(secFetchSite)) return reject()

  if (origin) {
    const host = req.headers.get('host') // Vercel-authoritative; forwarded-host is NOT trusted here
    let originHost: string
    try { originHost = new URL(origin).host } catch { return reject('Invalid origin') }
    if (!host || originHost !== host) return reject()
  }

  return null
}
