import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import OnboardingForm from '@/components/OnboardingForm'

export const metadata = { title: 'Get started | Cadre' }

export default async function OnboardingPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // If the user has already completed onboarding, go straight to dashboard
  const { data: prefs } = await supabase
    .from('user_preferences')
    .select('onboarding_completed')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  if (prefs?.onboarding_completed) {
    redirect('/dashboard/introductions')
  }

  return <OnboardingForm />
}
