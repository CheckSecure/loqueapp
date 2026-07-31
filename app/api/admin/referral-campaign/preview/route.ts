import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { computeReferralCampaignEligibility, checkRequiredCampaignMigrations, OPERATOR_EMAIL_LOWER } from '@/lib/referralCampaign/eligibility'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Read-only eligibility report for the referral campaign. Admin-gated; touches no
 * email and no DB writes — it only counts who WOULD receive the campaign and why
 * others are excluded, so the operator can sanity-check before firing the send.
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email?.toLowerCase() !== OPERATOR_EMAIL_LOWER) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { eligible, breakdown, dedupeColumnPresent } = await computeReferralCampaignEligibility()
  const migrations = await checkRequiredCampaignMigrations()

  return NextResponse.json({
    breakdown,
    dedupeColumnPresent,
    requiredMigrations: migrations,          // { ok, missing[] } — send refuses unless ok
    canSend: migrations.ok,
    eligibleCount: eligible.length,
    // A small sample only — never the full list (privacy: no member roster dump).
    sample: eligible.slice(0, 5).map((e) => ({ email: e.email })),
    ...(migrations.ok ? {} : {
      warning: `Required migration(s) not applied: ${migrations.missing.join(', ')}. The send route will refuse until these are applied.`,
    }),
  })
}
