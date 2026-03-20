import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import OnboardingForm from '@/components/OnboardingForm'

export const metadata = { title: 'Complete your profile | Loque' }

export default async function OnboardingPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('profile_complete')
    .eq('id', user.id)
    .single()

  if (profile?.profile_complete) {
    redirect('/dashboard/introductions')
  }

  return <OnboardingForm />
}
