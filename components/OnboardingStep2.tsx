'use client'

import { useState } from 'react'
import { serializeMultiSelectField } from '@/lib/profile/multiSelect'
import { useRouter } from 'next/navigation'
import { Loader2, CheckCircle, ArrowLeft } from 'lucide-react'

const PURPOSE_OPTIONS = ["Find customers", "Raise capital", "Hire talent", "Learn & grow", "Expand network", "Give back / mentor", "Explore opportunities"]
const INTEREST_OPTIONS = ["Sports", "Travel", "Food & wine", "Arts & culture", "Technology", "Fitness", "Reading", "Music", "Volunteering"]
const INTRO_PREFS = ['Investors', 'Founders', 'Potential hires', 'Collaborators', 'Mentors', 'Customers']

interface Profile {
  purposes?: string[]
  interests?: string[]
  intro_preferences?: string[]
}

export default function OnboardingStep2({
  profile,
  onBack,
}: {
  profile: Profile | null
  /**
   * Return to step 1. Present so a completion failure on a step-1-owned field (title, company,
   * physical location) is always ACTIONABLE: none of those has an input on this screen, so without
   * a way back the member would be told to fix something they cannot reach.
   */
  onBack?: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [purposes, setPurposes] = useState<string[]>(profile?.purposes || [])
  const [interests, setInterests] = useState<string[]>(profile?.interests || [])
  const [introPref, setIntroPref] = useState<string[]>(profile?.intro_preferences || [])
  const router = useRouter()

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const formData = new FormData(e.currentTarget)
    formData.set('purposes', serializeMultiSelectField(purposes))
    formData.set('interests', serializeMultiSelectField(interests))
    formData.set('intro_preferences', introPref.join(','))

    const response = await fetch('/api/profile/update', {
      method: 'POST',
      body: formData
    })

    const result = await response.json()

    if (result.error) {
      setError(result.error)
      setLoading(false)
    } else {
      // Mark profile as complete. The response MUST be checked: this call previously ran
      // fire-and-forget, so when it failed the member was navigated to /dashboard anyway with
      // profile_complete still false — the middleware then bounced them straight back to
      // onboarding, with nothing on screen to explain why. Never navigate on a failed completion.
      const completeRes = await fetch('/api/profile/complete', { method: 'POST' })
      if (!completeRes.ok) {
        const detail = await completeRes.json().catch(() => null)
        setError(detail?.error || 'We could not finish setting up your profile. Please try again.')
        setLoading(false)
        return
      }
      router.push('/dashboard')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Why these fields matter — they directly drive introduction quality. */}
      <div className="rounded-2xl border border-brand-gold/30 bg-brand-gold-soft/60 px-5 py-3.5">
        <p className="text-sm text-brand-navy font-semibold">These answers power your introductions</p>
        <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
          Andrel matches you on your goals, who you want to meet, your expertise, and your interests. The more you
          share here, the more — and stronger — introductions you&rsquo;ll receive.
        </p>
      </div>

      {/* Purposes */}
      <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-6">
        <h3 className="text-sm font-semibold text-slate-900 mb-1">Your goals on Andrel</h3>
        <p className="text-xs text-slate-400 mb-3">What are you looking to achieve through introductions?</p>
        <div className="grid grid-cols-2 gap-2">
          {PURPOSE_OPTIONS.map((purpose) => (
            <label key={purpose} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 accent-[#C4922A] rounded"
                checked={purposes.includes(purpose)}
                onChange={(e) =>
                  setPurposes(prev =>
                    e.target.checked ? [...prev, purpose] : prev.filter(p => p !== purpose)
                  )
                }
              />
              <span className="text-sm text-slate-700">{purpose}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Introduction preferences */}
      <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-6">
        <h3 className="text-sm font-semibold text-slate-900 mb-1">Introduction preferences</h3>
        <p className="text-xs text-slate-400 mb-3">What kinds of introductions do you welcome?</p>
        <div className="grid grid-cols-2 gap-2">
          {INTRO_PREFS.map((pref) => (
            <label key={pref} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 accent-[#C4922A] rounded"
                checked={introPref.includes(pref)}
                onChange={(e) =>
                  setIntroPref(prev =>
                    e.target.checked ? [...prev, pref] : prev.filter(p => p !== pref)
                  )
                }
              />
              <span className="text-sm text-slate-700">{pref}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Interests */}
      <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-6">
        <h3 className="text-sm font-semibold text-slate-900 mb-1">Personal interests</h3>
        <p className="text-xs text-slate-400 mb-3">Shared interests help build rapport in conversations</p>
        <div className="grid grid-cols-3 gap-2">
          {INTEREST_OPTIONS.map((interest) => (
            <label key={interest} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 accent-[#C4922A] rounded"
                checked={interests.includes(interest)}
                onChange={(e) =>
                  setInterests(prev =>
                    e.target.checked ? [...prev, interest] : prev.filter(i => i !== interest)
                  )
                }
              />
              <span className="text-sm text-slate-700">{interest}</span>
            </label>
          ))}
        </div>
      </div>

      {error && (
        <div role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 px-4 py-3 rounded-lg space-y-2">
          <p>{error}</p>
          {/* Title, company and physical location are all collected on step 1 and have no input on
              this screen. If completion failed on one of them, saying so without offering a way
              back would leave the member stuck on an instruction they cannot act on. */}
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="font-semibold underline underline-offset-2 hover:text-red-700"
            >
              Go back to edit your details
            </button>
          )}
        </div>
      )}

      <div className="flex flex-col-reverse sm:flex-row sm:items-center gap-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            disabled={loading}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 px-6 py-3 text-sm font-semibold text-slate-700 transition-colors hover:border-slate-300 hover:text-slate-900 disabled:opacity-60"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            Back
          </button>
        )}
        <button
          type="submit"
          disabled={loading}
          className="flex-1 flex items-center justify-center gap-2 bg-[#1B2850] text-white text-sm font-semibold px-6 py-3 rounded-lg hover:bg-[#2E4080] transition-colors disabled:opacity-60"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          {loading ? 'Completing setup...' : 'Complete Profile'}
        </button>
      </div>
    </form>
  )
}
