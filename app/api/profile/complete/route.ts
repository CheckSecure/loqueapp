import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateOnboardingRecommendations } from '@/lib/generate-recommendations'
import { sendAdminWelcome } from '@/lib/onboarding/welcomeFromAdmin'

export async function POST() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { error } = await supabase
    .from('profiles')
    .update({ profile_complete: true, onboarding_step: 2 })
    .eq('id', user.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Generate initial recommendations (idempotent — generator should de-dupe internally)
  try {
    const result = await generateOnboardingRecommendations(user.id)
    console.log('[profile/complete] Generated recommendations:', result.count)
  } catch (err: any) {
    console.error('[profile/complete] Recommendations error:', err?.message || err)
  }

  // Assign initial credits if the user does not have a credits row yet
  try {
    const adminClient = createAdminClient()
    const { data: existingCredits } = await adminClient
      .from('meeting_credits')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!existingCredits) {
      const { error: creditsError } = await adminClient
        .from('meeting_credits')
        .insert({ user_id: user.id, balance: 3, lifetime_earned: 3 })
      if (creditsError) {
        console.error('[profile/complete] Credits insert error:', creditsError.message)
      } else {
        console.log('[profile/complete] Assigned 3 credits to new user')
      }
    } else {
      console.log('[profile/complete] Credits already present, skipping assignment')
    }
  } catch (err: any) {
    console.error('[profile/complete] Credits assignment error:', err?.message || err)
  }

  // Award +1 credit to referrer if this user was referred and cap not hit
  try {
    const referralClient = createAdminClient()

    // Use auth email — by construction (Step 2 submit gate + invite flow),
    // auth.email = waitlist.email = the email the referral was submitted for.
    const userEmail = user.email
    if (!userEmail) throw new Error('No email on auth user')

    // Step 1: find waitlist row by email
    const { data: waitlistRow } = await referralClient
      .from('waitlist')
      .select('id')
      .ilike('email', userEmail)
      .maybeSingle()

    if (!waitlistRow) {
      console.log('[profile/complete] no waitlist row — not a referred user', { userId: user.id })
    } else {
      // Step 2: find referral row for this waitlist entry with status='invited'
      const { data: referralRow } = await referralClient
        .from('referrals')
        .select('id, referrer_user_id')
        .eq('waitlist_id', waitlistRow.id)
        .eq('status', 'invited')
        .maybeSingle()

      if (!referralRow) {
        console.log('[profile/complete] no invited referral row — skipping credit hook', { userId: user.id })
      } else {
        const referrerId = referralRow.referrer_user_id

        // Step 3: check referrer is still active
        const { data: referrerProfile } = await referralClient
          .from('profiles')
          .select('account_status')
          .eq('id', referrerId)
          .single()

        if (referrerProfile?.account_status !== 'active') {
          // Mark activated regardless — the referral relationship is real
          await referralClient
            .from('referrals')
            .update({ status: 'activated', activated_at: new Date().toISOString() })
            .eq('id', referralRow.id)
          console.log('[profile/complete] referral activated but credit skipped — referrer not active', { referrerId, userId: user.id })
        } else {
          // Step 4: mark referral activated
          await referralClient
            .from('referrals')
            .update({ status: 'activated', activated_at: new Date().toISOString() })
            .eq('id', referralRow.id)

          // Step 5: check monthly cap (5 credits awarded this calendar month)
          const monthStart = new Date()
          monthStart.setUTCDate(1)
          monthStart.setUTCHours(0, 0, 0, 0)
          const nextMonthStart = new Date(monthStart)
          nextMonthStart.setUTCMonth(nextMonthStart.getUTCMonth() + 1)

          const { count: monthlyAwarded } = await referralClient
            .from('referrals')
            .select('id', { count: 'exact', head: true })
            .eq('referrer_user_id', referrerId)
            .eq('awarded_credit', true)
            .gte('awarded_at', monthStart.toISOString())
            .lt('awarded_at', nextMonthStart.toISOString())

          if ((monthlyAwarded ?? 0) >= 5) {
            console.log('[profile/complete] referral credit cap reached', {
              referrerId,
              monthlyAwarded,
              cap: 5,
            })
          } else {
            // V1 accepted gap: theoretically two concurrent profile_complete calls could
            // each pass the cap check and double-award. Practically impossible — onboarding
            // is a single UI path. No DB lock for V1.

            // Increment referrer's free credits
            const { data: currentCredits } = await referralClient
              .from('meeting_credits')
              .select('free_credits, premium_credits, balance, lifetime_earned')
              .eq('user_id', referrerId)
              .single()

            const currentFree = currentCredits?.free_credits ?? 0
            const currentPremium = currentCredits?.premium_credits ?? 0
            const currentLifetime = currentCredits?.lifetime_earned ?? 0

            await referralClient
              .from('meeting_credits')
              .upsert({
                user_id: referrerId,
                free_credits: currentFree + 1,
                premium_credits: currentPremium,
                balance: currentFree + currentPremium + 1,
                lifetime_earned: currentLifetime + 1,
              }, { onConflict: 'user_id' })

            // Mark referral as credited
            await referralClient
              .from('referrals')
              .update({ awarded_credit: true, awarded_at: new Date().toISOString() })
              .eq('id', referralRow.id)

            console.log('[profile/complete] referral credit awarded', {
              referrerId,
              referralId: referralRow.id,
              userId: user.id,
            })
          }
        }
      }
    }
  } catch (err: any) {
    console.error('[profile/complete] referral credit hook error (non-blocking):', err?.message || err)
  }

  // Fire admin welcome (idempotent across all four gates, never throws)
  try {
    const welcome = await sendAdminWelcome(user.id)
    if (welcome.created) {
      console.log('[profile/complete] Admin welcome sent:', welcome.conversationId)
    } else {
      console.log('[profile/complete] Admin welcome skipped:', welcome.reason)
    }
  } catch (err: any) {
    console.error('[profile/complete] Admin welcome error (non-blocking):', err?.message || err)
  }

  return NextResponse.json({ success: true })
}
