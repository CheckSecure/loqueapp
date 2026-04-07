'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, CheckCircle } from 'lucide-react'

const PURPOSE_OPTIONS = ["Find customers", "Raise capital", "Hire talent", "Learn & grow", "Expand network", "Give back / mentor", "Explore opportunities"]
const INTEREST_OPTIONS = ["Sports", "Travel", "Food & wine", "Arts & culture", "Technology", "Fitness", "Reading", "Music", "Volunteering"]
const INTRO_PREFS = ['Investors', 'Founders', 'Potential hires', 'Collaborators', 'Mentors', 'Customers']

interface Profile {
  purposes?: string[]
  interests?: string[]
  intro_preferences?: string[]
}

export default function OnboardingStep2({ profile }: { profile: Profile | null }) {
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
    formData.set('purposes', purposes.join(','))
    formData.set('interests', interests.join(','))
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
      // Mark profile as complete
      await fetch('/api/profile/complete', {
        method: 'POST'
      })
      router.push('/dashboard')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
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

      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 px-4 py-3 rounded-lg">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="w-full flex items-center justify-center gap-2 bg-[#1B2850] text-white text-sm font-semibold px-6 py-3 rounded-lg hover:bg-[#2E4080] transition-colors disabled:opacity-60"
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
        {loading ? 'Completing setup...' : 'Complete Profile'}
      </button>
    </form>
  )
}
