import { createAdminClient } from '@/lib/supabase/admin'
import { createNotificationSafe } from '@/lib/notifications'
import { logRecommendationEvent } from '@/lib/analytics/recommendationEvents'

/**
 * Award the referrer's credit when a referred member finishes onboarding.
 *
 * EXTRACTED BECAUSE IT WAS ONLY EVER RUNNING FOR HALF THE MEMBERS. Two paths set
 * profiles.profile_complete = true, and migration 084 names both:
 *
 *   • POST /api/profile/complete       (components/OnboardingStep2)
 *   • completeOnboarding in app/actions (components/OnboardingForm)
 *
 * This logic lived inline in the first one. Anyone finishing through OnboardingForm had their
 * profile completed, their tier credits written and their admin welcome sent — and this never ran.
 * The referral stayed at 'invited' forever and nothing logged a failure, because nothing was
 * attempted. Nine activated nominees left their referrers uncredited that way. Every other
 * post-completion side effect already fired on both paths; this was the only one that did not,
 * which is exactly why it went unnoticed for so long.
 *
 * NEVER THROWS. Both callers treat it as fire-and-forget — a failure here must not break onboarding
 * for the member who just finished it. The outcome is returned instead, so callers can log it.
 *
 * Behaviour is preserved exactly from the original inline version. The nested if/else ladder is
 * rewritten as early returns because it was five levels deep at the point of the credit write.
 */

/** Awards are capped per referrer per calendar month. */
export const REFERRAL_CREDIT_MONTHLY_CAP = 5

export type ReferralAwardOutcome =
  | 'not_referred'          // no waitlist row for this address
  | 'no_invited_referral'   // waitlist row exists, but no referral at status 'invited'
  | 'referrer_inactive'     // relationship recorded, credit deliberately withheld
  | 'cap_reached'
  | 'awarded'
  | 'credit_write_failed'
  | 'error'

export async function awardReferralCreditOnCompletion(
  newUserId: string,
  newUserEmail: string | null | undefined,
): Promise<ReferralAwardOutcome> {
  try {
    if (!newUserEmail) return 'not_referred'
    const db = createAdminClient()

    // By construction (submit gate + invite flow) auth.email = waitlist.email = the address the
    // referral was submitted for.
    const { data: waitlistRow } = await db
      .from('waitlist')
      .select('id, full_name')
      .ilike('email', newUserEmail)
      .maybeSingle()

    if (!waitlistRow) {
      console.log('[referralCredit] no waitlist row — not a referred user', { userId: newUserId })
      return 'not_referred'
    }

    const { data: referralRow } = await db
      .from('referrals')
      .select('id, referrer_user_id')
      .eq('waitlist_id', waitlistRow.id)
      .eq('status', 'invited')
      .maybeSingle()

    if (!referralRow) {
      console.log('[referralCredit] no invited referral row — skipping', { userId: newUserId })
      return 'no_invited_referral'
    }

    const referrerId = referralRow.referrer_user_id
    const { data: referrerProfile } = await db
      .from('profiles')
      .select('account_status')
      .eq('id', referrerId)
      .maybeSingle()

    // The relationship is real either way, so it is marked activated before any decision about
    // the credit. An inactive referrer forfeits the credit, not the record.
    await db
      .from('referrals')
      .update({ status: 'activated', activated_at: new Date().toISOString() })
      .eq('id', referralRow.id)
    logRecommendationEvent('recommendation_joined', { referralId: referralRow.id, userId: newUserId })

    if (referrerProfile?.account_status !== 'active') {
      console.log('[referralCredit] activated but credit skipped — referrer not active', { referrerId, userId: newUserId })
      return 'referrer_inactive'
    }

    // Monthly cap, counted over awards already marked this calendar month.
    const monthStart = new Date()
    monthStart.setUTCDate(1)
    monthStart.setUTCHours(0, 0, 0, 0)
    const nextMonthStart = new Date(monthStart)
    nextMonthStart.setUTCMonth(nextMonthStart.getUTCMonth() + 1)

    const { count: monthlyAwarded } = await db
      .from('referrals')
      .select('id', { count: 'exact', head: true })
      .eq('referrer_user_id', referrerId)
      .eq('awarded_credit', true)
      .gte('awarded_at', monthStart.toISOString())
      .lt('awarded_at', nextMonthStart.toISOString())

    if ((monthlyAwarded ?? 0) >= REFERRAL_CREDIT_MONTHLY_CAP) {
      console.log('[referralCredit] cap reached', { referrerId, monthlyAwarded, cap: REFERRAL_CREDIT_MONTHLY_CAP })
      return 'cap_reached'
    }

    // The PURCHASED bucket: a referral credit is an earned reward, not a monthly allowance. Migration
    // 089 caps free_credits at 20 and refuses any update that raises it past that, so a reward
    // written there would compete with the member's refill and hard-fail at the ceiling.
    const { data: currentCredits } = await db
      .from('meeting_credits')
      .select('free_credits, premium_credits, balance, lifetime_earned')
      .eq('user_id', referrerId)
      .maybeSingle()

    const currentFree = currentCredits?.free_credits ?? 0
    const currentPremium = currentCredits?.premium_credits ?? 0
    const currentLifetime = currentCredits?.lifetime_earned ?? 0

    // DESTRUCTURED. supabase-js RETURNS a database error rather than throwing one, so a swallowed
    // failure here previously recorded the award as paid while the member received nothing.
    const { error: creditError } = await db
      .from('meeting_credits')
      .upsert({
        user_id: referrerId,
        free_credits: currentFree,
        premium_credits: currentPremium + 1,
        balance: currentFree + currentPremium + 1,
        lifetime_earned: currentLifetime + 1,
      }, { onConflict: 'user_id' })

    if (creditError) {
      // awarded_credit stays FALSE, so the referral remains eligible for a later grant and does
      // not consume a slot in the monthly cap.
      console.error('[referralCredit] REFERRAL_CREDIT_WRITE_FAILED', JSON.stringify({
        referrerId, referralId: referralRow.id,
        code: (creditError as any)?.code ?? null, message: creditError.message,
      }))
      return 'credit_write_failed'
    }

    const { error: markError } = await db
      .from('referrals')
      .update({ awarded_credit: true, awarded_at: new Date().toISOString() })
      .eq('id', referralRow.id)

    if (markError) {
      // The credit WAS granted but the marker did not persist. Logged rather than reversed:
      // over-crediting one member is a far smaller harm than clawing back an earned credit.
      console.error('[referralCredit] REFERRAL_CREDIT_MARK_FAILED', JSON.stringify({
        referrerId, referralId: referralRow.id,
        code: (markError as any)?.code ?? null, message: markError.message,
      }))
    }

    console.log('[referralCredit] awarded', { referrerId, referralId: referralRow.id, userId: newUserId, bucket: 'premium_credits' })

    // Fired only on a confirmed award. dedupeKey is the REFERRAL id, so it is exact-once per
    // nomination — someone who recommends five people who all join hears five times.
    const nomineeFirst = ((waitlistRow.full_name || '').trim().split(/\s+/)[0]) || ''
    await createNotificationSafe({
      userId: referrerId,
      type: 'referral_credit_awarded',
      dedupeKey: referralRow.id,
      data: { referralId: referralRow.id, joinedUserId: newUserId },
      ...(nomineeFirst
        ? {
            title: `${nomineeFirst} just joined — you earned a credit`,
            body: `Thanks for recommending ${nomineeFirst}. Your credit has been added, and we'll introduce you if it's a fit.`,
          }
        : {}),
    })

    return 'awarded'
  } catch (err: any) {
    console.error('[referralCredit] hook error (non-blocking):', err?.message || err)
    return 'error'
  }
}
