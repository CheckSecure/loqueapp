import { NextResponse } from 'next/server'
import { awardReferralCreditOnCompletion } from '@/lib/referrals/awardReferralCredit'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertSameOrigin } from '@/lib/http/sameOrigin'
import { generateOnboardingRecommendations } from '@/lib/generate-recommendations'
import { enqueueOnboardingRetry } from '@/lib/onboarding/retryQueue'
import { sendAdminWelcome } from '@/lib/onboarding/welcomeFromAdmin'
import { getEffectiveTier, getMonthlyCredits } from '@/lib/tier-override'
import { logRecommendationEvent } from '@/lib/analytics/recommendationEvents'
import { validateLocation } from '@/lib/validation/location'

export async function POST(req: Request) {
  const crossOrigin = assertSameOrigin(req)
  if (crossOrigin) return crossOrigin

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // Onboarding-completion identity gate (dashboard flow). OnboardingStep1 has
  // already persisted title/company via /api/profile/update; we re-validate the
  // stored values here — the completion route — so profile_complete can never be
  // set on invalid identity data. Kept consistent with completeOnboarding
  // (app/actions.ts): trim + require at least 2 visible characters, no blacklist.
  // Deliberately NOT added to /api/profile/update or updateProfile, so
  // existing-user profile editing (which shares /api/profile/update) is
  // unaffected and already-complete users are never retroactively validated.
  // A3: self read via service_role, scoped to the caller's own id. Authenticated SELECT on the
  // base profiles table is REVOKED (migration 058), so reading it with the caller's own client
  // returned 42501 permission-denied for EVERY caller. The error was discarded, `identity` fell
  // to null, and the checks below rejected the member's own valid, already-persisted title with
  // "Professional title is required." — so profile_complete could never be set on this path
  // (the legacy /dashboard/onboarding wizard, which is where finalizeReset sends new invitees).
  // A read failure must NOT be reported as a validation error, so it is surfaced separately.
  const { data: identity, error: identityError } = await createAdminClient()
    .from('profiles')
    .select('title, company, location')
    .eq('id', user.id)
    .single()

  if (identityError) {
    console.error('[profile/complete] identity read failed', { code: identityError.code, msg: identityError.message })
    return NextResponse.json({ error: 'Could not verify your profile. Please try again.' }, { status: 503 })
  }

  const title = (identity?.title || '').trim()
  const company = (identity?.company || '').trim()
  if (title.length < 2) {
    return NextResponse.json({ error: 'Professional title is required.' }, { status: 400 })
  }
  if (company.length < 2) {
    return NextResponse.json({ error: 'Company or organization is required.' }, { status: 400 })
  }

  // Physical location is required to become complete. Validated against the STORED
  // value — not the request body — so skipping or tampering with the client cannot
  // reach profile_complete=true: OnboardingStep1 must have successfully persisted a
  // real location via /api/profile/update first. Same shared authority as the
  // top-level completeOnboarding path (lib/validation/location).
  const locationCheck = validateLocation(identity?.location)
  if (!locationCheck.ok) {
    return NextResponse.json({ error: locationCheck.error }, { status: 400 })
  }

  // service_role write, scoped to the caller's own row (browser UPDATE on profiles revoked, migration 055).
  const { error } = await createAdminClient()
    .from('profiles')
    .update({ profile_complete: true, onboarding_step: 2 })
    .eq('id', user.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Generate initial recommendations (idempotent). Awaited; the unambiguous outcome is logged
  // structurally (no identifiers). A non-created outcome is retryable via a separately-authorized,
  // explicitly-targeted operation and is NOT reported as success — onboarding still completes so the
  // member is never blocked by an absent compatible candidate.
  try {
    const result = await generateOnboardingRecommendations(user.id)
    // Durable retry: enqueue THIS member only when retryable. Fail-open; log distinguishes a
    // genuinely-scheduled retry from an enqueue failure (never falsely claims durable retry).
    const durableRetryScheduled = result.retryable ? await enqueueOnboardingRetry(createAdminClient(), user.id, result.outcome) : false
    console.log('[profile/complete] recs', JSON.stringify({ outcome: result.outcome, created: result.count, retryable: result.retryable, durableRetryScheduled }))
  } catch (err: any) {
    console.error('[profile/complete] recs generation error (non-blocking):', err?.message || err)
  }

  // Tier-aware credit assignment + safety-net floor correction.
  //   - Insert path (no row): seed with getMonthlyCredits(effectiveTier).
  //   - Safety-net path (row exists, free_credits < floor): top up to floor
  //     and log a tier_credit_floor_correction audit row. Handles users whose
  //     tier was set post-invite via Stripe or admin action.
  //   - If existing free_credits >= floor: do nothing (preserves spent state).
  try {
    const adminClient = createAdminClient()

    const { data: profileForTier } = await adminClient
      .from('profiles')
      .select('subscription_tier, is_founding_member, founding_member_expires_at')
      .eq('id', user.id)
      .single()

    const effectiveTier = getEffectiveTier(profileForTier || {})
    const creditFloor = getMonthlyCredits(effectiveTier)

    const { data: existingCredits } = await adminClient
      .from('meeting_credits')
      .select('free_credits, premium_credits, balance, lifetime_earned')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!existingCredits) {
      const { error: creditsError } = await adminClient
        .from('meeting_credits')
        .insert({
          user_id: user.id,
          free_credits: creditFloor,
          premium_credits: 0,
          balance: creditFloor,
          lifetime_earned: creditFloor,
        })
      if (creditsError) {
        console.error('[profile/complete] Credits insert error:', creditsError.message)
      } else {
        await adminClient.from('credit_transactions').insert({
          user_id: user.id,
          amount: creditFloor,
          type: 'credit',
          note: effectiveTier === 'founding' ? 'founding_signup_bonus' : 'signup_bonus',
        })
        console.log('[profile/complete] Assigned credits to new user', { tier: effectiveTier, amount: creditFloor })
      }
    } else {
      const currentFree = existingCredits.free_credits ?? 0
      const currentPremium = existingCredits.premium_credits ?? 0
      const currentLifetime = existingCredits.lifetime_earned ?? 0
      if (currentFree < creditFloor) {
        const delta = creditFloor - currentFree
        const { error: updateError } = await adminClient
          .from('meeting_credits')
          .update({
            free_credits: creditFloor,
            balance: creditFloor + currentPremium,
            lifetime_earned: currentLifetime + delta,
          })
          .eq('user_id', user.id)
        if (updateError) {
          console.error('[profile/complete] Floor correction update error:', updateError.message)
        } else {
          await adminClient.from('credit_transactions').insert({
            user_id: user.id,
            amount: delta,
            type: 'credit',
            note: 'tier_credit_floor_correction',
          })
          console.log('[profile/complete] Floor correction applied', { tier: effectiveTier, from: currentFree, to: creditFloor })
        }
      } else {
        console.log('[profile/complete] Credits already at or above floor, skipping')
      }
    }
  } catch (err: any) {
    console.error('[profile/complete] Credits assignment error:', err?.message || err)
  }

  // Referral credit — shared with completeOnboarding in app/actions.ts, which is the OTHER path
  // that sets profile_complete. Living inline here is what caused nine activated nominees to leave
  // their referrers uncredited: members who finished through OnboardingForm never reached it.
  // Fire-and-forget by contract; it never throws.
  await awardReferralCreditOnCompletion(user.id, user.email)

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
