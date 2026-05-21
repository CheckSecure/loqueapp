import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendInviteReminder1, sendInviteReminder2 } from '@/lib/email'

// Daily cron. Sends at most one reminder per invited user, in two phases:
//   Reminder 1: invited 23–48h ago, never reminded, hasn't signed in
//   Reminder 2: invited >= 7 days ago, reminder 1 sent, hasn't signed in
// Activation = auth.users.last_sign_in_at IS NOT NULL. Once a user signs in,
// they're permanently disqualified from future reminders.

type AuthUserInfo = { id: string; last_sign_in_at: string | null }

async function buildAuthUserMap(admin: ReturnType<typeof createAdminClient>): Promise<Map<string, AuthUserInfo>> {
  const map = new Map<string, AuthUserInfo>()
  const perPage = 1000
  let page = 1
  // listUsers pages until a partial page comes back.
  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage })
    if (error) {
      console.error('[activation-reminders] listUsers failed:', error.message)
      break
    }
    for (const u of data.users) {
      if (u.email) {
        map.set(u.email.toLowerCase(), {
          id: u.id,
          last_sign_in_at: u.last_sign_in_at ?? null,
        })
      }
    }
    if (data.users.length < perPage) break
    page++
  }
  return map
}

async function processCandidate(
  admin: ReturnType<typeof createAdminClient>,
  candidate: { id: string; email: string; full_name: string | null },
  authMap: Map<string, AuthUserInfo>,
  phase: 1 | 2,
): Promise<'sent' | 'skipped_orphan' | 'skipped_activated' | 'failed'> {
  const authUser = authMap.get(candidate.email.toLowerCase())
  if (!authUser) return 'skipped_orphan'
  if (authUser.last_sign_in_at) return 'skipped_activated'

  const send = phase === 1 ? sendInviteReminder1 : sendInviteReminder2
  const column = phase === 1 ? 'invite_reminder_1_sent_at' : 'invite_reminder_2_sent_at'

  const result = await send(candidate.email, candidate.full_name || 'there')
  if (!result.success) {
    console.log(JSON.stringify({
      event: 'activation_reminder_failed',
      reminder: phase,
      waitlist_id: candidate.id,
      email: candidate.email,
      error: result.error,
    }))
    return 'failed'
  }

  const { error: updateError } = await admin
    .from('waitlist')
    .update({ [column]: new Date().toISOString() })
    .eq('id', candidate.id)

  if (updateError) {
    // Email already sent but tracking column failed — log so it can be reconciled.
    // Worst case: the next cron run resends. Mitigated by the 23h floor for reminder 1.
    console.log(JSON.stringify({
      event: 'activation_reminder_track_failed',
      reminder: phase,
      waitlist_id: candidate.id,
      email: candidate.email,
      error: updateError.message,
    }))
  }

  console.log(JSON.stringify({
    event: 'activation_reminder_sent',
    reminder: phase,
    waitlist_id: candidate.id,
    email: candidate.email,
  }))
  return 'sent'
}

export async function GET(req: Request) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const now = Date.now()
  const cutoff23h = new Date(now - 23 * 60 * 60 * 1000).toISOString()
  const cutoff48h = new Date(now - 48 * 60 * 60 * 1000).toISOString()
  const cutoff7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()

  const authMap = await buildAuthUserMap(admin)

  // --- Reminder 1: 23–48h since invite, no reminder yet ---
  const { data: r1Candidates } = await admin
    .from('waitlist')
    .select('id, email, full_name')
    .eq('status', 'invited')
    .not('invited_at', 'is', null)
    .gte('invited_at', cutoff48h)
    .lte('invited_at', cutoff23h)
    .is('invite_reminder_1_sent_at', null)

  let r1Sent = 0, r1Orphan = 0, r1Activated = 0, r1Failed = 0
  for (const c of r1Candidates || []) {
    const outcome = await processCandidate(admin, c, authMap, 1)
    if (outcome === 'sent') r1Sent++
    else if (outcome === 'skipped_orphan') r1Orphan++
    else if (outcome === 'skipped_activated') r1Activated++
    else r1Failed++
  }

  // --- Reminder 2: invited >= 7d ago, reminder 1 sent, reminder 2 not sent ---
  const { data: r2Candidates } = await admin
    .from('waitlist')
    .select('id, email, full_name')
    .eq('status', 'invited')
    .lte('invited_at', cutoff7d)
    .not('invite_reminder_1_sent_at', 'is', null)
    .is('invite_reminder_2_sent_at', null)

  let r2Sent = 0, r2Orphan = 0, r2Activated = 0, r2Failed = 0
  for (const c of r2Candidates || []) {
    const outcome = await processCandidate(admin, c, authMap, 2)
    if (outcome === 'sent') r2Sent++
    else if (outcome === 'skipped_orphan') r2Orphan++
    else if (outcome === 'skipped_activated') r2Activated++
    else r2Failed++
  }

  console.log(
    `[activation-reminders] done — r1: sent=${r1Sent} orphan=${r1Orphan} activated=${r1Activated} failed=${r1Failed}; ` +
    `r2: sent=${r2Sent} orphan=${r2Orphan} activated=${r2Activated} failed=${r2Failed}`,
  )

  return NextResponse.json({
    reminder_1: { sent: r1Sent, skipped_orphan: r1Orphan, skipped_activated: r1Activated, failed: r1Failed },
    reminder_2: { sent: r2Sent, skipped_orphan: r2Orphan, skipped_activated: r2Activated, failed: r2Failed },
  })
}
