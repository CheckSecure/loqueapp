import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import ProfileForm from '@/components/ProfileForm'

export default async function OnboardingPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user) {
    redirect('/login')
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (profile?.profile_complete) {
    redirect('/dashboard')
  }

  return (
    <div className="min-h-screen bg-[#F5F6FB] py-12 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="bg-white rounded-2xl shadow-lg p-8 mb-6">
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Welcome to Andrel!</h1>
          <p className="text-slate-600 mb-6">Complete your profile to start making meaningful connections.</p>
        </div>
        
        <ProfileForm initialData={profile} isOnboarding={true} />
      </div>
    </div>
  )
}
