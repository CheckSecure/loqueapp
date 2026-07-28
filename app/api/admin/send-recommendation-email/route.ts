import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'
import { sendRecommendationIntroductionEmail } from '@/lib/email'
import { checkNomineeDuplicates } from '@/lib/referrals/duplicateCheck'
import { makeManageToken } from '@/lib/referrals/manageToken'
import { isMissingColumnError } from '@/lib/db/isMissingColumn'
import { logRecommendationEvent } from '@/lib/analytics/recommendationEvents'
import { isBlockedTransition, invalidTransitionMessage } from '@/lib/referrals/statusTransitions'

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
    .select('id, full_name, email, referral_source, status')
    .eq('id', entryId)
    .maybeSingle()
  if (!entry) return NextResponse.json({ error: 'Entry not found' }, { status: 404 })
  if (!entry.email) return NextResponse.json({ error: 'Entry has no email' }, { status: 400 })

  // Enforce the lifecycle server-side: warm email only from approved (first send)
  // or contacted (resend). Never from pending / invited / declined.
  if (isBlockedTransition(entry.status, 'contacted')) {
    return NextResponse.json(
      { ok: false, error: invalidTransitionMessage(entry.status, 'contacted') },
      { status: 409 },
    )
  }

  // Resolve the recommender's name from the linked referral.
  const { data: referralRow } = await admin
    .from('referrals')
    .select('referrer:profiles!referrer_user_id(full_name)')
    .eq('waitlist_id', entryId)
    .maybeSingle()
  // Raw recommender name ('' when none) — the email builder renders the natural
  // "A founding member of Andrel…" phrasing for the blank case (no doubling).
  const recommenderName = (referralRow?.referrer as any)?.full_name || ''

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

  // ── Idempotency: MARK first, THEN send ────────────────────────────────────
  // Persist the 'contacted' state (+ timestamps) BEFORE sending. If this write
  // fails we return WITHOUT sending, so a founder retry can never produce a
  // duplicate warm email from a "email sent → status write failed" partial
  // failure. Resilient to migration 028 not being applied yet (status-only).
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
    // Nothing was emailed — safe to retry.
    return NextResponse.json({ ok: false, error: 'Could not update the nomination status — no email was sent. Please try again.' }, { status: 500 })
  }

  // ── Send the warm email ───────────────────────────────────────────────────
  const manageUrl = `${BASE_URL}/manage-information?token=${encodeURIComponent(makeManageToken(entryId))}`
  const result = await sendRecommendationIntroductionEmail(
    entry.email,
    entry.full_name || '', // blank → builder greets "Hello," (no "Hello there,")
    recommenderName,
    manageUrl,
  )
  if (!result.success) {
    // Status is already 'contacted'; the row is in the Contacted tab where the
    // founder can explicitly "Resend Recommendation" — no silent duplicate.
    return NextResponse.json({ ok: false, error: `Marked contacted, but the email failed to send (${result.error}). Use Resend Recommendation.` }, { status: 500 })
  }

  logRecommendationEvent('recommendation_email_sent', { entryId, recommender: recommenderName })

  revalidatePath('/dashboard', 'layout')
  return NextResponse.json({ ok: true, success: true, state: 'contacted' })
}
