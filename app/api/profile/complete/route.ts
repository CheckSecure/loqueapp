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
