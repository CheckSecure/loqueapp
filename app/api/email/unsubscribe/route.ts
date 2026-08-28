import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifyUnsubscribeToken, normalizeEmail } from '@/lib/email/unsubscribe'

/**
 * PUBLIC, UNAUTHENTICATED. Authority comes from the HMAC signature on the token, never from a
 * session — the whole point is that an invite recipient with no account can unsubscribe.
 *
 * GET NEVER UNSUBSCRIBES. Corporate mail gateways and link scanners pre-fetch every URL in a
 * message; if GET mutated, a scanner would unsubscribe people who never clicked anything. GET
 * therefore renders a confirmation page whose button POSTs. This mirrors the reasoning already
 * documented in lib/referrals/manageToken.ts for the nominee manage link.
 *
 * POST is the RFC 8058 one-click target, invoked by the receiving provider itself.
 */
export const dynamic = 'force-dynamic'

function tokenFrom(request: Request): string | null {
  return new URL(request.url).searchParams.get('token')
}

function page(title: string, body: string, status = 200): NextResponse {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} | Andrel</title>
<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:15vh auto;padding:0 24px;color:#334155;text-align:center">
  ${body}
</div>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  ) as NextResponse
}

export async function GET(request: Request) {
  const token = tokenFrom(request)
  const claim = verifyUnsubscribeToken(token)
  if (!claim) {
    return page('Link expired', `
      <h1 style="color:#1B2850;font-size:20px">This unsubscribe link isn't valid</h1>
      <p style="font-size:15px;line-height:1.6">It may have been altered in transit. Reply to
      <a href="mailto:hello@andrel.app" style="color:#1B2850">hello@andrel.app</a> and we'll remove you.</p>`, 400)
  }
  // Confirmation only — no write. See the note above on scanner pre-fetch.
  return page('Unsubscribe', `
    <h1 style="color:#1B2850;font-size:20px">Unsubscribe ${escapeHtmlLite(claim.email)}?</h1>
    <p style="font-size:15px;line-height:1.6">We'll stop sending you this kind of email.</p>
    <form method="POST" action="/api/email/unsubscribe?token=${encodeURIComponent(token || '')}">
      <button type="submit" style="margin-top:12px;background:#1B2850;color:#fff;border:0;border-radius:10px;padding:12px 24px;font-size:15px;font-weight:600;cursor:pointer">
        Unsubscribe
      </button>
    </form>`)
}

export async function POST(request: Request) {
  const token = tokenFrom(request)
  const claim = verifyUnsubscribeToken(token)
  if (!claim) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
  }

  // service_role: migration 091 gives email_suppressions no browser-role privileges, and this
  // request carries no session by design.
  const admin = createAdminClient()
  const { error } = await admin
    .from('email_suppressions')
    .upsert(
      { email: normalizeEmail(claim.email), category: claim.category, source: 'one_click' },
      { onConflict: 'email,category', ignoreDuplicates: true },
    )

  if (error) {
    // Destructured and logged rather than swallowed: a silent failure here means we keep mailing
    // someone who asked us to stop, which is the exact failure this whole change exists to fix.
    console.error('[unsubscribe] suppression write failed:', error)
    return NextResponse.json({ error: 'Could not record unsubscribe' }, { status: 500 })
  }

  console.log(JSON.stringify({ event: 'email_unsubscribed', category: claim.category, source: 'one_click' }))

  // Providers performing a one-click POST want a plain 200; humans arriving from the confirmation
  // form want a page. Both are satisfied by returning the page.
  return page('Unsubscribed', `
    <h1 style="color:#1B2850;font-size:20px">You're unsubscribed</h1>
    <p style="font-size:15px;line-height:1.6">${escapeHtmlLite(claim.email)} won't receive these emails again.</p>
    <p style="font-size:13px;color:#94a3b8;line-height:1.6">Changed your mind? Adjust your preferences any time in
    <a href="/dashboard/settings" style="color:#94a3b8">settings</a>.</p>`)
}

/** Local, minimal escape — the address is echoed back into HTML. */
function escapeHtmlLite(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
