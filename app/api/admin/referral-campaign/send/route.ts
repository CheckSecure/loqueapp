import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendReferralRequestEmail } from '@/lib/email'
import { computeReferralCampaignEligibility, checkRequiredCampaignMigrations, OPERATOR_EMAIL_LOWER } from '@/lib/referralCampaign/eligibility'
import { logRecommendationEvent } from '@/lib/analytics/recommendationEvents'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

const BATCH_SIZE = 10
const BATCH_PAUSE_MS = 1000
const DEFAULT_LIMIT = 1000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * One-time "Help us grow the Andrel network" campaign send. Admin-gated and
 * confirmation-gated. Idempotent + resumable by construction:
 *   • Eligibility already excludes members whose referral_campaign_sent_at is set,
 *     so a re-run only targets members not yet successfully emailed.
 *   • The sent marker is stamped PER ROW and ONLY after Resend accepts the message.
 *     A failed send leaves the marker NULL, so the member is retried next run and
 *     is never double-sent.
 *   • If a mid-batch timeout kills the function, the rows already stamped are done
 *     and a re-trigger continues with the remainder.
 * Sends nothing to recommended people — this emails existing members only.
 */
export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email?.toLowerCase() !== OPERATOR_EMAIL_LOWER) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: { confirmation?: unknown; limit?: unknown } = {}
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  // Exact-match guard against accidental fire. Anything other than the literal
  // string 'SEND' is rejected with no send.
  if (payload.confirmation !== 'SEND') {
    return NextResponse.json({ error: "Confirmation string 'SEND' required." }, { status: 400 })
  }

  // Hard safety stop: refuse until ALL required migrations are present (035 dedupe
  // AND 037 consent — not just 035). Without 035 the send can't dedupe/resume;
  // without 037 the email's consent promise can't be honored (consent is unstorable).
  const migrations = await checkRequiredCampaignMigrations()
  if (!migrations.ok) {
    return NextResponse.json({
      error: `Refusing to send: required migration(s) not applied: ${migrations.missing.join(', ')}. Apply all required migrations before running the campaign.`,
      missingMigrations: migrations.missing,
    }, { status: 409 })
  }

  const { eligible, breakdown } = await computeReferralCampaignEligibility()

  const rawLimit = typeof payload.limit === 'number' ? payload.limit : DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(rawLimit, DEFAULT_LIMIT))
  const targets = eligible.slice(0, limit)

  const admin = createAdminClient()
  let sent = 0
  let failed = 0
  const failures: Array<{ email: string; error: string }> = []

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE)
    for (const row of batch) {
      try {
        const result = await sendReferralRequestEmail(row.email, row.full_name ?? 'there')
        if (result.success) {
          // Stamp the marker ONLY after a provider-accepted send. Immediate per-row
          // write so a mid-batch timeout leaves succeeded rows recorded (resumable).
          await admin
            .from('profiles')
            .update({ referral_campaign_sent_at: new Date().toISOString() })
            .eq('id', row.id)
          logRecommendationEvent('recommendation_campaign_sent', { memberId: row.id })
          sent++
        } else {
          failures.push({ email: row.email, error: result.error ?? 'unknown error' })
          failed++
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown exception'
        failures.push({ email: row.email, error: message })
        failed++
      }
    }
    if (i + BATCH_SIZE < targets.length) {
      await sleep(BATCH_PAUSE_MS)
    }
  }

  return NextResponse.json({
    attempted: targets.length,
    sent,
    failed,
    failures,
    breakdown,
    resumable: true,
  })
}
