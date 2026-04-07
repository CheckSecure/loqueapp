'use client'

import { useEffect, useState } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import OnboardingStep1 from '@/components/OnboardingStep1'
import OnboardingStep2 from '@/components/OnboardingStep2'
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

      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single()

      if (profile?.profile_complete) {
        window.location.href = '/dashboard'
        return
      }

      setUser(user)
      setProfile(profile)
      setCurrentStep(profile?.onboarding_step || 1)
      setLoading(false)
    }

    loadProfile()
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F5F6FB]">
        <Loader2 className="w-8 h-8 text-slate-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#F5F6FB] py-12 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Progress indicator */}
        <div className="mb-8">
          <div className="flex items-center justify-center gap-2 mb-4">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold ${currentStep === 1 ? 'bg-[#1B2850] text-white' : 'bg-[#C4922A] text-white'}`}>
              1
            </div>
            <div className={`h-1 w-16 ${currentStep === 2 ? 'bg-[#C4922A]' : 'bg-slate-200'}`} />
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold ${currentStep === 2 ? 'bg-[#1B2850] text-white' : 'bg-slate-200 text-slate-400'}`}>
              2
            </div>
          </div>
          <p className="text-center text-sm text-slate-600">
            {currentStep === 1 ? 'Step 1: Build Your Profile' : 'Step 2: Set Your Preferences'}
          </p>
        </div>

        {/* Welcome banner */}
        <div className="bg-white rounded-2xl shadow-lg p-8 mb-6">
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
          <OnboardingStep2 profile={profile} />
        )}
      </div>
    </div>
  )
}
