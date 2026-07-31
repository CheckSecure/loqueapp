import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendReferralRequestEmail } from '@/lib/email'
import { OPERATOR_EMAIL_LOWER } from '@/lib/referralCampaign/eligibility'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Send a single referral-campaign test email to the operator only. Writes NO
 * dedupe marker and touches no member — purely a "what will members see" check
 * before the real send. Admin-gated.
 */
export async function POST() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email?.toLowerCase() !== OPERATOR_EMAIL_LOWER) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await sendReferralRequestEmail(user.email as string, 'there')
  if (!result.success) {
    return NextResponse.json({ error: result.error ?? 'send failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, sentTo: user.email })
}
