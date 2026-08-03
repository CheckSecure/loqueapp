import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import OnboardingForm from '@/components/OnboardingForm'
import { pickOnboardingPrefillName } from '@/lib/validation/fullName'

export const metadata = { title: 'Complete your profile | Andrel' }

export default async function OnboardingPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('profile_complete, full_name')
    .eq('id', user.id)
    .single()

  if (profile?.profile_complete) {
    redirect('/dashboard/introductions')
  }

  // Prefill the name field: existing valid profile name → valid waitlist name
  // (the name they were invited under) → blank. This is what would have prevented
  // Eric's one-word entry — with no profile name yet, "Eric Eller" from the
  // waitlist is offered. Prefill only; the member can still edit it.
  let waitlistName: string | null = null
  if (user.email) {
    const { data: wl } = await createAdminClient()
      .from('waitlist')
      .select('full_name')
      .ilike('email', user.email)
      .maybeSingle()
    waitlistName = (wl as { full_name: string | null } | null)?.full_name ?? null
  }
  const initialFullName = pickOnboardingPrefillName(profile?.full_name ?? null, waitlistName)

  return <OnboardingForm initialFullName={initialFullName} />
}
