import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendLaunchAnnouncementEmail } from '@/lib/email'
import { computeLaunchAnnouncementEligibility } from '@/lib/launchAnnouncement/eligibility'

export const runtime = 'nodejs'
export const maxDuration = 60

const ADMIN_EMAIL = 'bizdev91@gmail.com'
const BATCH_SIZE = 10
const BATCH_PAUSE_MS = 1000
const DEFAULT_LIMIT = 1000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: { confirmation?: unknown; limit?: unknown } = {}
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  // Exact-match guard against accidental fire. Anything other than the literal
  // string 'SEND' is rejected with no DB read, no Resend call.
  if (payload.confirmation !== 'SEND') {
    return NextResponse.json({ error: 'Confirmation string required.' }, { status: 400 })
  }

  const rawLimit = typeof payload.limit === 'number' ? payload.limit : DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(rawLimit, DEFAULT_LIMIT))

  const { eligible } = await computeLaunchAnnouncementEligibility()
  const targets = eligible.slice(0, limit)

  const admin = createAdminClient()
  let sent = 0
  let failed = 0
  const failures: Array<{ email: string; error: string }> = []

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE)
    for (const row of batch) {
      try {
        const result = await sendLaunchAnnouncementEmail(row.email, row.full_name ?? 'there')
        if (result.success) {
          // Per-row immediate write: if the Vercel function times out mid-batch,
          // rows that already succeeded are recorded as sent, and a re-trigger
          // picks up from where it left off without double-sending.
          await admin
            .from('waitlist')
            .update({
              launch_announcement_sent_at: new Date().toISOString(),
              launch_announcement_email_error: null,
            })
            .eq('id', row.id)
          sent++
        } else {
          await admin
            .from('waitlist')
            .update({ launch_announcement_email_error: result.error ?? 'unknown error' })
            .eq('id', row.id)
          failures.push({ email: row.email, error: result.error ?? 'unknown error' })
          failed++
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown exception'
        await admin
          .from('waitlist')
          .update({ launch_announcement_email_error: message })
          .eq('id', row.id)
        failures.push({ email: row.email, error: message })
        failed++
      }
    }
    // Pause between batches to stay well under Resend rate limits.
    if (i + BATCH_SIZE < targets.length) {
      await sleep(BATCH_PAUSE_MS)
    }
  }

  return NextResponse.json({
    attempted: targets.length,
    sent,
    failed,
    failures,
  })
}
