import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildSecureInviteEmail } from '@/lib/email/secureInvite'

/**
 * Render the catch-up invitation exactly as it will be sent — WITHOUT sending, and WITHOUT minting
 * a link.
 *
 * WHY THE LINKS ARE FAKE, and why that is not a shortcut.
 *
 * A real invitation link authenticates the person it was minted for. Returning one in an HTTP
 * response — or emailing a nominee's link to an operator "just to look at it" — hands the holder a
 * working sign-in for somebody else's account. The whole invitation path is built so the link
 * reaches nothing but the email sender: never returned, never logged, never stored. A preview
 * endpoint is exactly where that discipline would quietly break, so this route never calls
 * generateLink or mintBoundResumeLink at all.
 *
 * The placeholders are visibly inert (#preview-...) so nobody mistakes a preview for a live link.
 * To verify the links THEMSELVES work end to end, send a real catch-up to an address you control
 * via INVITATIONS_MODE=test + INVITATION_TEST_EMAILS — the links are then real and authenticate
 * you, which is the only safe way to click one.
 *
 * GET renders HTML for the browser. Query params:
 *   ?name=Paul Skalny      recipient name (first name is what appears)
 *   ?referrer=Larry Katz   referrer name — omit to see the anonymous variant
 *   ?variant=first_invite  defaults to access_resend (the catch-up copy)
 *   ?resume=0              drop the resume link to see the pre-078 wording
 *   ?waitlistId=<uuid>     load the REAL name and consent-resolved referrer for that nominee
 *   ?format=json           subject/html/text as JSON instead of a rendered page
 */
export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

const PLACEHOLDER_LINK = '#preview-only-no-real-sign-in-link-is-minted'
const PLACEHOLDER_RESUME = '#preview-only-no-real-resume-link-is-minted'

export async function GET(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const variant = url.searchParams.get('variant') === 'first_invite' ? 'first_invite' : 'access_resend'
  const withResume = url.searchParams.get('resume') !== '0'
  const waitlistId = url.searchParams.get('waitlistId')

  let toName = url.searchParams.get('name') || 'Paul Skalny'
  let referrerName: string | null = url.searchParams.get('referrer')
  let source = 'query parameters'

  // Real data path: resolve the nominee's stored name and the CONSENT-RESOLVED referrer, so the
  // preview shows what that specific person would actually receive — including the anonymous
  // variant when their referrer withheld consent.
  if (waitlistId) {
    const admin = createAdminClient()
    const { data: w, error: wErr } = await admin
      .from('waitlist').select('full_name, email').eq('id', waitlistId).maybeSingle()
    if (wErr || !w) {
      return NextResponse.json({ error: 'No such waitlist row' }, { status: 404 })
    }
    toName = w.full_name || 'there'
    const { data: r, error: rErr } = await admin
      .from('referrals')
      .select('referrer_consent_to_share, referrer:profiles!referrer_user_id(full_name)')
      .eq('waitlist_id', waitlistId)
      .maybeSingle()
    // Error is READ, not swallowed: a failed lookup must not masquerade as "no consent" here any
    // more than it may in the send path.
    if (rErr) return NextResponse.json({ error: 'Referral lookup failed' }, { status: 503 })
    referrerName = (r as any)?.referrer_consent_to_share === true
      ? ((r as any)?.referrer?.full_name ?? null)
      : null
    source = `waitlist row ${waitlistId} (${w.email}) — referrer ${referrerName ? 'named (consented)' : 'withheld (no consent)'}`
  }

  const built = buildSecureInviteEmail({
    toName,
    referrerName,
    purpose: variant,
    link: PLACEHOLDER_LINK,
    resumeLink: withResume ? PLACEHOLDER_RESUME : null,
  })

  if (url.searchParams.get('format') === 'json') {
    return NextResponse.json({ ...built, source, linksAreReal: false })
  }

  // A banner above the message, so a screenshot of this page can never be mistaken for a real send.
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Catch-up email preview</title>
<div style="font-family:system-ui,-apple-system,sans-serif;max-width:680px;margin:24px auto;padding:0 16px">
  <div style="background:#FEF3C7;border:1px solid #FDE68A;border-radius:10px;padding:12px 16px;margin-bottom:20px">
    <p style="margin:0;font-size:13px;color:#92400E"><strong>PREVIEW — nothing was sent and no link was minted.</strong></p>
    <p style="margin:6px 0 0;font-size:13px;color:#92400E">Both links are inert placeholders. Variant:
      <strong>${built.variant}</strong>. Source: ${escapeAttr(source)}.</p>
  </div>
  <p style="font-size:12px;color:#64748b;margin:0 0 4px">Subject</p>
  <p style="font-size:15px;font-weight:600;color:#0f172a;margin:0 0 20px">${escapeAttr(built.subject)}</p>
  <div style="border:1px solid #e2e8f0;border-radius:12px;padding:20px">${built.html}</div>
</div>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
  ) as NextResponse
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
