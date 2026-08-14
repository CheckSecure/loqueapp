import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertSameOrigin } from '@/lib/http/sameOrigin'
import { checkRateLimit } from '@/lib/rateLimit'
import { sendAdminAlertEmail, escapeHtml } from '@/lib/email'

/**
 * POST /api/issues/report — same-origin, authenticated ACTIVE member, strict JSON.
 *
 * Body: exactly { report_text, page_url?, user_agent? }. report_text is required and capped at 4,000
 * chars; page_url/user_agent are bounded. A durable, atomic per-user rate limit (migration 056) gates
 * the endpoint: over the limit → 429 + Retry-After, and NO issue_reports row is written and NO admin
 * email is sent. user_id/user_email come from the session, never the body.
 */
const NO_STORE = { 'Cache-Control': 'no-store' }
const MAX_REPORT_CHARS = 4000
const RATE_LIMIT = 5
const RATE_WINDOW_SECONDS = 600 // 5 reports / 10 minutes per user

export async function POST(req: Request) {
  const crossOrigin = assertSameOrigin(req)
  if (crossOrigin) return crossOrigin

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })

  const admin = createAdminClient()

  // Active-member check (deactivated accounts cannot file reports).
  const { data: profile } = await admin.from('profiles').select('account_status').eq('id', user.id).maybeSingle()
  if (profile && profile.account_status !== 'active') {
    return NextResponse.json({ error: 'This account is not active.' }, { status: 403, headers: NO_STORE })
  }

  if (!(req.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
    return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 400, headers: NO_STORE })
  }
  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: NO_STORE }) }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Body must be an object' }, { status: 400, headers: NO_STORE })
  }
  if (Object.keys(body).some((k) => k !== 'report_text' && k !== 'page_url' && k !== 'user_agent')) {
    return NextResponse.json({ error: 'Only { report_text, page_url, user_agent } are accepted' }, { status: 400, headers: NO_STORE })
  }

  const reportText = (typeof body.report_text === 'string' ? body.report_text : '').trim().slice(0, MAX_REPORT_CHARS)
  if (!reportText) {
    return NextResponse.json({ error: 'Report text required' }, { status: 400, headers: NO_STORE })
  }
  const pageUrl = typeof body.page_url === 'string' ? body.page_url.slice(0, 2000) : null
  const userAgent = typeof body.user_agent === 'string' ? body.user_agent.slice(0, 1000) : null

  // Durable atomic per-user rate limit — checked BEFORE any write or email. FAILS CLOSED: only an
  // authoritative 'allowed' result may proceed. A limiter error/timeout/malformed result → 503 (nothing
  // inserted, no email); a confirmed over-limit → 429. Both carry Retry-After.
  const rl = await checkRateLimit(admin, { key: `issue_report:${user.id}`, limit: RATE_LIMIT, windowSeconds: RATE_WINDOW_SECONDS })
  if (rl.status === 'error') {
    return NextResponse.json(
      { error: 'Service temporarily unavailable. Please try again shortly.' },
      { status: 503, headers: { ...NO_STORE, 'Retry-After': String(rl.retryAfterSeconds) } },
    )
  }
  if (rl.status === 'over_limit') {
    return NextResponse.json(
      { error: 'Too many reports. Please try again later.' },
      { status: 429, headers: { ...NO_STORE, 'Retry-After': String(rl.retryAfterSeconds) } },
    )
  }

  const { error } = await admin
    .from('issue_reports')
    .insert({
      user_id: user.id,
      user_email: user.email || '',
      report_text: reportText,
      page_url: pageUrl,
      user_agent: userAgent,
    })
  if (error) {
    console.error('[issues/report] insert error:', error)
    return NextResponse.json({ error: 'Failed to save report' }, { status: 500, headers: NO_STORE })
  }

  const alertResult = await sendAdminAlertEmail(
    `New issue report from ${escapeHtml(user.email)}`,
    `
      <h2 style="color: #1B2850; margin-bottom: 24px;">New issue report</h2>
      <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;"><strong>Reporter:</strong> ${escapeHtml(user.email)}</p>
      <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;"><strong>Page:</strong> ${escapeHtml(pageUrl)}</p>
      <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;"><strong>Report:</strong></p>
      <div style="background: #F5F6FB; border-left: 3px solid #1B2850; padding: 16px; margin: 16px 0; border-radius: 4px;">
        <p style="color: #334155; font-size: 15px; margin: 0;">${escapeHtml(reportText)}</p>
      </div>
      <a href="https://andrel.app/dashboard/admin" style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">View in Admin</a>
    `
  )
  if (!alertResult.success) {
    console.error('[issues/report] admin alert failed:', alertResult.error)
  }

  return NextResponse.json({ success: true }, { headers: NO_STORE })
}
