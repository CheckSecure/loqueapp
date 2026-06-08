import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { computeLaunchAnnouncementEligibility } from '@/lib/launchAnnouncement/eligibility'

export const runtime = 'nodejs'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export async function POST() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { eligible, ineligible } = await computeLaunchAnnouncementEligibility()

  const breakdown = {
    already_sent: 0,
    status_declined: 0,
    status_invited: 0,
    already_active_member: 0,
    operator_account: 0,
  }
  for (const { reason } of ineligible) breakdown[reason]++

  const sample = eligible.slice(0, 10).map((r) => ({
    full_name: r.full_name,
    email: r.email,
    created_at: r.created_at,
  }))

  return NextResponse.json({
    eligible: { count: eligible.length, sample },
    ineligible_breakdown: breakdown,
  })
}
