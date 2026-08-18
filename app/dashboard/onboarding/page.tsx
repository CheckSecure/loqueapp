'use client'

import { useEffect, useState } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import OnboardingStep1 from '@/components/OnboardingStep1'
import OnboardingStep2 from '@/components/OnboardingStep2'
import { resolveWizardStartStep } from '@/lib/onboarding/steps'
import { Loader2 } from 'lucide-react'

export default function OnboardingPage() {
  const [profile, setProfile] = useState<any>(null)
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [currentStep, setCurrentStep] = useState(1)
  const supabase = createClient()

  useEffect(() => {
    async function loadProfile() {
      const { data: { user } } = await supabase.auth.getUser()
      
      if (!user) {
        window.location.href = '/login'
        return
      }

      // A3: self read of the caller's OWN full row via get_my_profile() (base-table SELECT revoked;
      // no member-facing SELECT * on profiles).
      const { data: myRows } = await supabase.rpc('get_my_profile')
      const profile = Array.isArray(myRows) ? (myRows[0] ?? null) : (myRows ?? null)

      if (profile?.profile_complete) {
        window.location.href = '/dashboard'
        return
      }

      setUser(user)
      setProfile(profile)
      // Open on the step the DATA supports, not the stored marker alone. A profile parked at
      // step 2 whose step-1 fields (title / company / physical location) do not yet satisfy
      // POST /api/profile/complete opens on step 1, where those inputs live — otherwise the
      // member sees only step 2, which has no location field, and Complete Profile fails on a
      // value the screen gives them no way to enter. Never advances past the marker.
      setCurrentStep(resolveWizardStartStep(profile))
      setLoading(false)
    }

    loadProfile()
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brand-cream">
        <Loader2 className="w-8 h-8 text-slate-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-brand-cream py-12 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Progress indicator */}
        <div className="mb-8">
          <div className="flex items-center justify-center gap-3 mb-4">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${
              currentStep === 1
                ? 'bg-brand-navy text-white'
                : 'bg-brand-gold text-white'
            }`}>
              1
            </div>
            <div className={`h-0.5 w-16 transition-colors ${currentStep === 2 ? 'bg-brand-gold' : 'bg-slate-200'}`} />
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${
              currentStep === 2
                ? 'bg-brand-navy text-white'
                : 'bg-slate-200 text-slate-400'
            }`}>
              2
            </div>
          </div>
          <p className="text-center text-sm text-slate-600">
            {currentStep === 1 ? 'Step 1: Build Your Profile' : 'Step 2: Set Your Preferences'}
          </p>
        </div>

        {/* Welcome banner */}
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 md:p-8 mb-6">
          <h1 className="text-3xl font-bold text-slate-900 mb-2">
            {currentStep === 1 ? 'Welcome to Andrel!' : 'Almost done!'}
          </h1>
          <p className="text-slate-600">
            {currentStep === 1 
              ? 'Tell us about yourself to get started making meaningful connections.'
              : 'Set your preferences so we can match you with the right people.'}
          </p>
        </div>
        
        {/* Step content */}
        {currentStep === 1 ? (
          <OnboardingStep1 
            profile={profile} 
            email={user?.email ?? ''} 
            onNext={() => setCurrentStep(2)}
          />
        ) : (
          <OnboardingStep2 profile={profile} onBack={() => setCurrentStep(1)} />
        )}
      </div>
    </div>
  )
}
