'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { saveOnboardingPreferences } from '@/app/actions'
import { ChevronRight, ChevronLeft, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

const WHO_TO_MEET = [
  'In-house attorneys', 'Law firm partners', 'Legal ops', 'Consultants', 'Legal tech founders',
  'Executive / C-Suite', 'Investor / VC', 'Government / Policy', 'Finance Professional', 'Healthcare Professional',
]
const SENIORITY = ['Junior', 'Mid-level', 'Senior', 'Executive']
const REASONS = ['Business development', 'Mentorship', 'Learning', 'Referrals', 'Collaboration', 'Hiring']
const MENTORSHIP_TOPICS = ['Career growth', 'In-house transition', 'Legal tech', 'Leadership', 'BD']
const GEOGRAPHIC_OPTIONS = [
  'Remote / Global', 'North America', 'Europe', 'Asia-Pacific', 'Middle East', 'Latin America', 'Africa',
]
const CADENCE_OPTIONS = ['Weekly', 'Bi-weekly', 'Monthly', 'Quarterly']

function CheckGroup({
  options,
  selected,
  onChange,
}: {
  options: string[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const toggle = (val: string) =>
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val])

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => {
        const active = selected.includes(opt)
        return (
          <button
            key={opt}
            type="button"
            onClick={() => toggle(opt)}
            className={cn(
              'px-3.5 py-2 rounded-lg text-sm font-medium border transition-all',
              active
                ? 'bg-[#1B2850] text-white border-[#1B2850]'
                : 'bg-white text-slate-600 border-slate-200 hover:border-[#1B2850]/40 hover:text-[#1B2850]'
            )}
          >
            {opt}
          </button>
        )
      })}
    </div>
  )
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-slate-100 last:border-0">
      <span className="text-sm text-slate-700 font-medium">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={cn(
          'relative w-11 h-6 rounded-full transition-colors focus:outline-none',
          value ? 'bg-[#1B2850]' : 'bg-slate-200'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform',
            value ? 'translate-x-5' : 'translate-x-0'
          )}
        />
      </button>
    </div>
  )
}

export default function OnboardingForm() {
  const router = useRouter()
  const [step, setStep] = useState(1)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Step 1 state
  const [whoToMeet, setWhoToMeet] = useState<string[]>([])
  const [seniority, setSeniority] = useState<string[]>([])
  const [reasons, setReasons] = useState<string[]>([])

  // Step 2 state
  const [geoPreference, setGeoPreference] = useState('')
  const [openVirtual, setOpenVirtual] = useState(true)
  const [openInPerson, setOpenInPerson] = useState(true)
  const [mentorshipTopics, setMentorshipTopics] = useState<string[]>([])
  const [cadence, setCadence] = useState('')

  const handleSubmit = async () => {
    setSaving(true)
    setError(null)
    const result = await saveOnboardingPreferences({
      who_to_meet: whoToMeet,
      preferred_seniority: seniority,
      reasons_to_connect: reasons,
      geographic_preference: geoPreference,
      open_to_virtual: openVirtual,
      open_to_in_person: openInPerson,
      mentorship_topics: mentorshipTopics,
      meeting_cadence: cadence,
    })
    if (result.error) {
      setError(result.error)
      setSaving(false)
      return
    }
    router.push('/dashboard/introductions')
  }

  return (
    <div className="min-h-screen bg-[#F5F6FB] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-xl">

        {/* Header */}
        <div className="text-center mb-8">
          <span className="text-2xl font-bold text-[#1B2850] tracking-tight block mb-6">Loque</span>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">
            {step === 1 ? 'Who do you want to meet?' : 'How do you prefer to connect?'}
          </h1>
          <p className="text-slate-500 text-sm">
            {step === 1
              ? 'Tell us who you\'re looking to connect with so we can curate your introductions.'
              : 'Set your availability and mentorship preferences.'}
          </p>
        </div>

        {/* Progress bar */}
        <div className="flex items-center gap-2 mb-8">
          {[1, 2].map((n) => (
            <div key={n} className="flex-1">
              <div className={cn(
                'h-1.5 rounded-full transition-colors',
                n <= step ? 'bg-[#C4922A]' : 'bg-slate-200'
              )} />
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-400 text-center -mt-5 mb-8">Step {step} of 2</p>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 space-y-7">

          {step === 1 ? (
            <>
              <div>
                <label className="block text-sm font-semibold text-slate-800 mb-3">
                  Who do you want to meet?
                </label>
                <CheckGroup options={WHO_TO_MEET} selected={whoToMeet} onChange={setWhoToMeet} />
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-800 mb-3">
                  Preferred seniority
                </label>
                <CheckGroup options={SENIORITY} selected={seniority} onChange={setSeniority} />
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-800 mb-3">
                  Reasons to connect
                </label>
                <CheckGroup options={REASONS} selected={reasons} onChange={setReasons} />
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="block text-sm font-semibold text-slate-800 mb-2">
                  Geographic preference
                </label>
                <select
                  value={geoPreference}
                  onChange={(e) => setGeoPreference(e.target.value)}
                  className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition bg-white"
                >
                  <option value="">Any location</option>
                  {GEOGRAPHIC_OPTIONS.map(o => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-800 mb-1">
                  Meeting availability
                </label>
                <div className="mt-2">
                  <Toggle label="Open to virtual meetings" value={openVirtual} onChange={setOpenVirtual} />
                  <Toggle label="Open to in-person meetings" value={openInPerson} onChange={setOpenInPerson} />
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-800 mb-3">
                  Mentorship topics <span className="text-slate-400 font-normal text-xs ml-1">optional</span>
                </label>
                <CheckGroup options={MENTORSHIP_TOPICS} selected={mentorshipTopics} onChange={setMentorshipTopics} />
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-800 mb-2">
                  Preferred meeting cadence
                </label>
                <select
                  value={cadence}
                  onChange={(e) => setCadence(e.target.value)}
                  className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition bg-white"
                >
                  <option value="">No preference</option>
                  {CADENCE_OPTIONS.map(o => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </div>

              {error && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 px-4 py-3 rounded-lg">{error}</p>
              )}
            </>
          )}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between mt-6">
          {step === 2 ? (
            <button
              type="button"
              onClick={() => setStep(1)}
              className="flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-700 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
              Back
            </button>
          ) : (
            <div />
          )}

          {step === 1 ? (
            <button
              type="button"
              onClick={() => setStep(2)}
              className="flex items-center gap-2 bg-[#1B2850] text-white text-sm font-semibold px-6 py-2.5 rounded-lg hover:bg-[#2E4080] transition-colors"
            >
              Continue
              <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={saving}
              className="flex items-center gap-2 bg-[#C4922A] text-white text-sm font-semibold px-6 py-2.5 rounded-lg hover:bg-[#b07e21] transition-colors disabled:opacity-60"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {saving ? 'Saving...' : 'Go to my dashboard'}
            </button>
          )}
        </div>

        {/* Skip */}
        <p className="text-center mt-4">
          <button
            type="button"
            onClick={() => router.push('/dashboard/introductions')}
            className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
          >
            Skip for now
          </button>
        </p>
      </div>
    </div>
  )
}
