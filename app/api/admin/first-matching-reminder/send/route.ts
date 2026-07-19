import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendFirstMatchingRoundReminderEmail } from '@/lib/email'
import { toCompletedEmailSet } from '@/lib/waitlist/joined'
import { selectReminderCohort, CAMPAIGN_ID, type ReminderWaitlistRow } from '@/lib/firstMatchingReminder/eligibility'

export const runtime = 'nodejs'
export const maxDuration = 60

const ADMIN_EMAIL = 'bizdev91@gmail.com'
const BATCH_SIZE = 10
const BATCH_PAUSE_MS = 1000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * One-time "first matching round" reminder send. Idempotent: each recipient is
 * marked with first_matching_reminder_sent_at the instant their send succeeds,
 * and the cohort query excludes anyone already marked — so a re-trigger or a
 * mid-run timeout never double-sends. Requires the literal confirmation 'SEND'.
 */
export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: { confirmation?: unknown; dryRun?: unknown } = {}
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  const dryRun = payload.dryRun === true
  // Exact-match guard against accidental fire. A real send requires 'SEND'.
  if (!dryRun && payload.confirmation !== 'SEND') {
    return NextResponse.json({ error: "Confirmation string 'SEND' required." }, { status: 400 })
  }

  const admin = createAdminClient()

  // Cohort = invited & not-completed & valid & not-already-sent, deduped.
  const { data: invitedRows } = await admin
    .from('waitlist')
    .select('id, email, full_name, status, first_matching_reminder_sent_at')
    .eq('status', 'invited')
  const { data: completedProfiles } = await admin
    .from('profiles')
    .select('email')
    .eq('profile_complete', true)

  const completedEmails = toCompletedEmailSet(completedProfiles)
  const { recipients, stats } = selectReminderCohort(
    (invitedRows ?? []) as ReminderWaitlistRow[],
    completedEmails,
  )

  if (dryRun) {
    return NextResponse.json({ campaign: CAMPAIGN_ID, dryRun: true, stats })
  }

  let sent = 0
  let failed = 0
  const failures: Array<{ id: string; error: string }> = [] // id only — never emails

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE)
    for (const r of batch) {
      try {
        const result = await sendFirstMatchingRoundReminderEmail(r.email, r.firstName)
        if (result.success) {
          // Per-row immediate write: a success is recorded before the next send,
          // so a timeout/retry resumes without re-emailing this recipient.
          await admin
            .from('waitlist')
            .update({ first_matching_reminder_sent_at: new Date().toISOString(), first_matching_reminder_error: null })
            .eq('id', r.id)
          sent++
        } else {
          await admin
            .from('waitlist')
            .update({ first_matching_reminder_error: result.error ?? 'unknown error' })
            .eq('id', r.id)
          failures.push({ id: r.id, error: result.error ?? 'unknown error' })
          failed++
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown exception'
        await admin
          .from('waitlist')
          .update({ first_matching_reminder_error: message })
          .eq('id', r.id)
        failures.push({ id: r.id, error: message })
        failed++
      }
    }
    if (i + BATCH_SIZE < recipients.length) await sleep(BATCH_PAUSE_MS)
  }

  return NextResponse.json({
    campaign: CAMPAIGN_ID,
    attempted: recipients.length,
    sent,
    failed,
    stats,
    failures,
  })
}
