import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createNotificationSafe } from '@/lib/notifications'
import {
  computeReferralCampaignEligibility,
  checkRequiredCampaignMigrations,
} from '@/lib/referralCampaign/eligibility'

/**
 * IN-APP referral campaign — the notification channel, alongside the existing email at
 * /api/admin/referral-campaign/send.
 *
 * Chosen over an inbox message because a message renders as plain text: ConversationView does
 * <p className="whitespace-pre-wrap">{msg.content}</p>, so a URL in the body is inert and every
 * member would have to retype it. A notification carries a real link and is one click from the
 * form it is asking them to fill in.
 *
 * DRY RUN IS THE DEFAULT. `action` must be the literal string 'execute' to write anything.
 *
 * EXACT-ONCE, not at-most-once-per-run: every notification carries a dedupeKey, and migration 006's
 * unique index on (user_id, type, data->>'dedupeKey') makes a repeat insert a no-op rather than a
 * duplicate. A half-finished run is therefore safe to re-run — which matters, because there is no
 * per-member "sent" stamp for this channel and nothing else would stop a second pass from
 * notifying everyone twice.
 */
export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

/** Hard ceiling per invocation. Re-run to continue; the dedupeKey makes that safe. */
const MAX_PER_RUN = 500

/** Written into data->>'dedupeKey'. CHANGING THIS RE-NOTIFIES EVERYONE — treat it as a campaign id. */
const CAMPAIGN_KEY = 'referral_campaign_2026_09'

const BATCH_SIZE = 25

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { action?: unknown; limit?: unknown; userIds?: unknown } = {}
  try { body = await req.json() } catch { /* empty body → dry run */ }

  const execute = body.action === 'execute'
  const limit = Math.min(
    MAX_PER_RUN,
    Math.max(1, Number.isFinite(Number(body.limit)) ? Number(body.limit) : MAX_PER_RUN),
  )
  const only = Array.isArray(body.userIds)
    ? new Set(body.userIds.filter((v): v is string => typeof v === 'string'))
    : null

  // Same migration guard the email campaign uses; a missing dedupe index would turn the
  // exact-once guarantee into "notify again on every run".
  const migrations = await checkRequiredCampaignMigrations()

  // respectEmailSentStamp: false — profiles.referral_campaign_sent_at belongs to the EMAIL
  // channel. Honouring it here would exclude exactly the members already engaged with the
  // campaign. Idempotency for this channel is the dedupeKey, not that column.
  //
  // respectEmailOptOut: true — a member who switched off product updates has said they do not
  // want to be marketed to. That preference is named for email, but the intent covers a
  // promotional in-app nudge too, and over-honouring it costs less than under-honouring it.
  const { eligible, breakdown } = await computeReferralCampaignEligibility({
    respectEmailSentStamp: false,
    respectEmailOptOut: true,
  })

  const targets = eligible.filter((m) => !only || only.has(m.id)).slice(0, limit)

  if (!execute) {
    return NextResponse.json({
      mode: 'dry_run',
      campaignKey: CAMPAIGN_KEY,
      migrations,
      breakdown,
      wouldNotify: targets.length,
      eligibleTotal: eligible.length,
      // The exact copy, so it is reviewable without reading the source.
      preview: {
        title: 'Who else belongs here?',
        body: "Recommend 3-5 people who'd fit — in-house counsel, law firm attorneys, government affairs, or executives. Each one is personally reviewed, and you earn 1 credit for every nominee who joins, up to 5 a month.",
        link: '/dashboard/referrals',
      },
      recipients: targets.map((m) => ({ id: m.id, email: m.email, name: m.full_name })),
    })
  }

  if (!migrations.ok) {
    // Refuse rather than notify: without the dedupe index a re-run would notify everyone again.
    return NextResponse.json(
      { error: 'Required migrations are not applied', missing: migrations.missing },
      { status: 409 },
    )
  }

  let created = 0
  let deduped = 0
  let failed = 0

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE)
    for (const m of batch) {
      // createNotificationSafe NEVER throws and returns null on a unique-violation, which is the
      // intended idempotent outcome rather than an error.
      const row = await createNotificationSafe({
        userId: m.id,
        type: 'referral_campaign',
        data: { dedupeKey: CAMPAIGN_KEY },
      })
      if (row) created++
      else deduped++
    }
  }

  console.log(JSON.stringify({
    event: 'referral_campaign_notified',
    campaignKey: CAMPAIGN_KEY, created, deduped, failed,
  }))

  return NextResponse.json({
    mode: 'execute',
    campaignKey: CAMPAIGN_KEY,
    attempted: targets.length,
    created,
    // Already notified in an earlier run, or a concurrent duplicate — not a failure.
    deduped,
    eligibleTotal: eligible.length,
  })
}
