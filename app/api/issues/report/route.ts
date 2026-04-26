import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * POST /api/issues/report
 *
 * Accepts a user-submitted issue report and stores it in issue_reports.
 *
 * Body: {
 *   report_text: string (required, non-empty)
 *   page_url?: string
 *   user_agent?: string
 * }
 *
 * Returns: { success: true } or { error: string }
 *
 * Auth required. Uses admin client for the insert (bypasses RLS) after
 * validating the user is authenticated. The user_id and user_email are
 * pulled from the authenticated session — never from the request body.
 */
export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { report_text?: string; page_url?: string; user_agent?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const reportText = (body?.report_text || '').trim()
  if (!reportText) {
    return NextResponse.json({ error: 'Report text required' }, { status: 400 })
  }

  const pageUrl = typeof body?.page_url === 'string' ? body.page_url.slice(0, 2000) : null
  const userAgent = typeof body?.user_agent === 'string' ? body.user_agent.slice(0, 1000) : null

  const admin = createAdminClient()
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
    return NextResponse.json({ error: 'Failed to save report' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
