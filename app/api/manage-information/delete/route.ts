import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifyManageToken } from '@/lib/referrals/manageToken'

/**
 * Nominee data removal — POST only (never GET), so an email scanner that auto-opens
 * the manage link cannot delete anything. The token identifies the waitlist row;
 * on success we remove the nominee's referral link(s) and their waitlist record.
 * Idempotent: an already-removed nominee returns ok.
 */
export async function POST(request: Request) {
  let body: any = {}
  try { body = await request.json() } catch { /* empty */ }

  const waitlistId = verifyManageToken(body?.token)
  if (!waitlistId) {
    return NextResponse.json({ ok: false, error: 'Invalid or expired link.' }, { status: 400 })
  }

  const admin = createAdminClient()

  // Remove referral link(s) first (FK child), then the waitlist record (PII).
  const { error: refErr } = await admin.from('referrals').delete().eq('waitlist_id', waitlistId)
  if (refErr) {
    console.error('[manage-information/delete] referrals delete failed:', refErr.message)
    return NextResponse.json({ ok: false, error: 'Could not remove your information. Please try again.' }, { status: 500 })
  }

  const { error: wlErr } = await admin.from('waitlist').delete().eq('id', waitlistId)
  if (wlErr) {
    console.error('[manage-information/delete] waitlist delete failed:', wlErr.message)
    return NextResponse.json({ ok: false, error: 'Could not remove your information. Please try again.' }, { status: 500 })
  }

  console.log('[manage-information/delete] removed nominee record', { waitlistId })
  return NextResponse.json({ ok: true })
}
