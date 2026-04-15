import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateOnboardingRecommendations } from '@/lib/generate-recommendations'

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

  // Generate initial recommendations for new user
  try {
    const result = await generateOnboardingRecommendations(user.id)
    console.log('[profile-complete] Generated recommendations:', result.count)
  } catch (err) {
    console.error('[profile-complete] Error generating recommendations:', err)
  }

  return NextResponse.json({ success: true })
}
