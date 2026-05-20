import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendDigestEmail } from '@/lib/email'

export async function GET(req: Request) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // Candidate recipients: anyone with an email who hasn't been active in 24h.
  // Per-user opt-out is enforced inside sendDigestEmail via email_daily_digest.
  const { data: profiles } = await admin
    .from('profiles')
    .select('id, full_name, email, last_active_at')
    .not('email', 'is', null)
    .or(`last_active_at.is.null,last_active_at.lt.${cutoff}`)

  if (!profiles || profiles.length === 0) {
    console.log('[daily-digest] no eligible users')
    return NextResponse.json({ sent: 0 })
  }

  let sent = 0
  let skipped = 0

  for (const profile of profiles) {
    if (!profile.email) continue

    // Count unread messages from the past 24 hours (single SQL join via rpc)
    let unreadMessages = 0
    try {
      const { data: msgCount } = await admin
        .rpc('count_unread_messages_since', { p_user_id: profile.id, p_since: cutoff })
      unreadMessages = (msgCount as number) ?? 0
    } catch (err) {
      console.error(`[daily-digest] message count failed for ${profile.id}:`, err)
    }

    // Count meeting requests awaiting the user's response from the past 24 hours
    let pendingMeetings = 0
    try {
      const { count } = await admin
        .from('meetings')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_id', profile.id)
        .in('status', ['requested', 'reschedule_requested'])
        .gte('created_at', cutoff)
      pendingMeetings = count ?? 0
    } catch (err) {
      console.error(`[daily-digest] meeting count failed for ${profile.id}:`, err)
    }

    if (unreadMessages === 0 && pendingMeetings === 0) {
      skipped++
      continue
    }

    const result = await sendDigestEmail(
      profile.email,
      profile.full_name || 'there',
      unreadMessages,
      pendingMeetings
    )
    if (result.success) {
      sent++
    } else {
      console.error(`[daily-digest] email failed for ${profile.id}:`, result.error)
    }
  }

  console.log(`[daily-digest] done — sent: ${sent}, skipped (nothing pending): ${skipped}, eligible: ${profiles.length}`)
  return NextResponse.json({ sent, skipped, eligible: profiles.length })
}
