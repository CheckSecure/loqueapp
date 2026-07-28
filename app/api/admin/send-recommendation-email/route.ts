import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'
import { sendRecommendationIntroductionEmail } from '@/lib/email'
import { checkNomineeDuplicates } from '@/lib/referrals/duplicateCheck'
import { makeManageToken } from '@/lib/referrals/manageToken'
import { isMissingColumnError } from '@/lib/db/isMissingColumn'
import { logRecommendationEvent } from '@/lib/analytics/recommendationEvents'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

const BASE_URL = 'https://www.andrel.app'

/**
 * Founder-only: send the warm recommendation-introduction email to a nominee and
 * move the nomination to 'contacted'. Nothing sends automatically — this is invoked
 * explicitly from the admin review UI after a preview + confirmation. Duplicate
 * protection runs first; a block is only bypassed with an explicit override (and,
 * for a previously-declined nominee, an explicit reason).
 */
export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { entryId, override, overrideReason } = await request.json()
  if (!entryId) return NextResponse.json({ error: 'Missing entryId' }, { status: 400 })

  const admin = createAdminClient()

  const { data: entry } = await admin
    .from('waitlist')
    .select('id, full_name, email, referral_source')
    .eq('id', entryId)
    .maybeSingle()
  if (!entry) return NextResponse.json({ error: 'Entry not found' }, { status: 404 })
  if (!entry.email) return NextResponse.json({ error: 'Entry has no email' }, { status: 400 })

  // Resolve the recommender's name from the linked referral.
  const { data: referralRow } = await admin
    .from('referrals')
    .select('referrer:profiles!referrer_user_id(full_name)')
    .eq('waitlist_id', entryId)
    .maybeSingle()
  const recommenderName = (referralRow?.referrer as any)?.full_name || 'A founding member'

  // ── Duplicate protection (before any send) ────────────────────────────────
  const dup = await checkNomineeDuplicates(admin, entry.email, entryId)
  if (dup.blocked) {
    if (!override) {
      // Surface the reason — never send silently.
      return NextResponse.json(
        { ok: false, blocked: true, code: dup.code, reason: dup.reason, overridable: dup.overridable, requiresReason: dup.requiresReason },
        { status: 409 },
      )
    }
    if (!dup.overridable) {
      return NextResponse.json(
        { ok: false, blocked: true, code: dup.code, reason: `${dup.reason} — this cannot be overridden.` },
        { status: 403 },
      )
    }
    if (dup.requiresReason && !String(overrideReason || '').trim()) {
      // Previously-declined: a meaningful reason is required — "time passed" alone is not enough.
      return NextResponse.json(
        { ok: false, blocked: true, code: dup.code, reason: 'A reason is required to re-engage a previously declined nominee.', requiresReason: true },
        { status: 400 },
      )
    }
    console.warn('[send-recommendation-email] OVERRIDE', {
      entryId, code: dup.code, reason: dup.reason, overrideReason: overrideReason || null,
    })
  }

  // ── Send the warm email ───────────────────────────────────────────────────
  const manageUrl = `${BASE_URL}/manage-information?token=${encodeURIComponent(makeManageToken(entryId))}`
  const result = await sendRecommendationIntroductionEmail(
    entry.email,
    entry.full_name || 'there',
    recommenderName,
    manageUrl,
  )
  if (!result.success) {
    return NextResponse.json({ ok: false, error: `Email failed: ${result.error}` }, { status: 500 })
  }

  // ── Mark contacted (resilient to migration 028 not yet applied) ───────────
  const now = new Date().toISOString()
  let { error: updErr } = await admin
    .from('waitlist')
    .update({ status: 'contacted', contacted_at: now, recommendation_email_sent_at: now })
    .eq('id', entryId)
  if (updErr && isMissingColumnError(updErr)) {
    console.warn('[send-recommendation-email] timestamp columns missing; setting status only (apply migration 028)')
    ;({ error: updErr } = await admin.from('waitlist').update({ status: 'contacted' }).eq('id', entryId))
  }
  if (updErr) {
    return NextResponse.json({ ok: false, error: 'Email sent but status update failed. Please refresh.' }, { status: 500 })
  }

  logRecommendationEvent('recommendation_email_sent', { entryId, recommender: recommenderName })

  revalidatePath('/dashboard', 'layout')
  return NextResponse.json({ ok: true, success: true, state: 'contacted' })
}
