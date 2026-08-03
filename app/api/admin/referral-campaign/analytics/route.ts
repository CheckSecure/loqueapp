import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { computeCampaignAnalytics } from '@/lib/referralCampaign/analytics'
import { OPERATOR_EMAIL_LOWER } from '@/lib/referralCampaign/eligibility'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Read-only referral-campaign analytics. Admin-gated. No writes, no email.
 *   ?include=internal  → include operator/admin/test activity (diagnostic)
 *   ?format=csv        → per-member CSV export, reflecting the current toggle
 */
function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function GET(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email?.toLowerCase() !== OPERATOR_EMAIL_LOWER) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const includeInternal = url.searchParams.get('include') === 'internal'
  const analytics = await computeCampaignAnalytics({ includeInternal })

  if (url.searchParams.get('format') === 'csv') {
    const header = ['name', 'email', 'campaign_sent_at', 'campaign_rec_count', 'all_time_rec_count', 'first_campaign_rec_at', 'latest_rec_at', 'campaign_invitations', 'campaign_activations']
    const lines = [header.join(',')]
    for (const m of analytics.members) {
      lines.push([
        m.full_name, m.email, m.campaignSentAt, m.campaignRecCount, m.allTimeRecCount,
        m.firstCampaignRecAt, m.latestRecAt, m.campaignInvitations, m.campaignActivations,
      ].map(csvCell).join(','))
    }
    return new NextResponse(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="referral-campaign-analytics${includeInternal ? '-internal' : ''}.csv"`,
      },
    })
  }

  return NextResponse.json(analytics)
}
