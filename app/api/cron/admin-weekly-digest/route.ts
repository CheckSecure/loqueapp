import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendAdminAlertEmail, escapeHtml, truncate } from '@/lib/email'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  // New waitlist signups (7d)
  const { data: newWaitlist } = await admin
    .from('waitlist')
    .select('full_name, email, title, company, created_at')
    .gte('created_at', sevenDaysAgo)
    .order('created_at', { ascending: false })

  // Issue reports (7d)
  const { data: newIssues } = await admin
    .from('issue_reports')
    .select('user_email, report_text, created_at')
    .gte('created_at', sevenDaysAgo)
    .order('created_at', { ascending: false })

  // Pending intro requests — health signal
  const { count: pendingIntros } = await admin
    .from('intro_requests')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')

  // New members (7d)
  const { count: newMembers } = await admin
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', sevenDaysAgo)

  const waitlistRows = (newWaitlist || [])
    .map(r => `<li style="margin-bottom:8px;"><strong>${escapeHtml(r.full_name)}</strong> — ${escapeHtml(r.email)}${r.title ? `, ${escapeHtml(r.title)}` : ''}${r.company ? ` at ${escapeHtml(r.company)}` : ''}</li>`)
    .join('')

  const issueRows = (newIssues || [])
    .map(r => `<li style="margin-bottom:8px;"><strong>${escapeHtml(r.user_email)}</strong>: ${escapeHtml(truncate(r.report_text, 120))}</li>`)
    .join('')

  const weekEnding = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

  const html = `
    <h2 style="color: #1B2850; margin-bottom: 24px;">Weekly digest</h2>
    <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">Week ending ${weekEnding}</p>

    <h3 style="color: #1B2850; margin-bottom: 12px;">New members (7d): ${newMembers ?? 0}</h3>

    <h3 style="color: #1B2850; margin-bottom: 12px;">Waitlist signups (7d): ${newWaitlist?.length ?? 0}</h3>
    ${waitlistRows
      ? `<ul style="color: #334155; font-size: 15px; padding-left: 20px; margin-bottom: 24px;">${waitlistRows}</ul>`
      : '<p style="color: #64748b; font-size: 15px; margin-bottom: 24px;">None</p>'}

    <h3 style="color: #1B2850; margin-bottom: 12px;">Issue reports (7d): ${newIssues?.length ?? 0}</h3>
    ${issueRows
      ? `<ul style="color: #334155; font-size: 15px; padding-left: 20px; margin-bottom: 24px;">${issueRows}</ul>`
      : '<p style="color: #64748b; font-size: 15px; margin-bottom: 24px;">None</p>'}

    <h3 style="color: #1B2850; margin-bottom: 12px;">Pending intro requests: ${pendingIntros ?? 0}</h3>

    <a href="https://andrel.app/dashboard/admin" style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">Open Admin Dashboard</a>
  `

  const result = await sendAdminAlertEmail('Weekly digest', html)

  if (!result.success) {
    console.error('[Weekly Digest] Email failed:', result.error)
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  console.log('[Weekly Digest] Sent successfully', {
    newMembers: newMembers ?? 0,
    waitlistSignups: newWaitlist?.length ?? 0,
    issueReports: newIssues?.length ?? 0,
    pendingIntros: pendingIntros ?? 0,
  })
  return NextResponse.json({ success: true })
}
