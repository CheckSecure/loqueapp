'use client'

import { useState, useRef } from 'react'
import SearchableTitleSelect from '@/components/SearchableTitleSelect'
import RecruiterGuidancePanel from '@/components/onboarding/RecruiterGuidance'
import EmploymentStatusField from '@/components/profile/EmploymentStatusField'
import { isEmploymentStatus, previewCompatibility, employmentStatusOption } from '@/lib/profile/employmentStatus'
import SearchableExpertiseSelect from '@/components/SearchableExpertiseSelect'
import ConnectionTargetPicker from '@/components/ConnectionTargetPicker'
import type { CategoryTitleSelection } from '@/lib/role-taxonomy'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { completeOnboarding } from '@/app/actions'
import { Loader2, User, Camera, Eye, EyeOff } from 'lucide-react'
import Image from 'next/image'
import { cn } from '@/lib/utils'
import { isValidFullName, FULL_NAME_ERROR } from '@/lib/validation/fullName'
import { validateLocation, LOCATION_HELP_TEXT } from '@/lib/validation/location'
import { RequiredMark, RequiredLegend } from '@/components/ui/RequiredMark'
import CurrentFocusAreasInput from '@/components/CurrentFocusAreasInput'
import { onboardingStepList, initialOnboardingStep } from '@/lib/onboarding/steps'

// Role-type picker — Phase B replaces the flat A-1 button list with a
// category → title picker (components/RoleCategoryPicker.tsx) sourced from
// lib/role-taxonomy.ts ROLE_CATEGORIES. Legacy-value safety is handled
// inside the picker (pinned "Current:" chip for non-structured stored values).

const SENIORITY_LEVELS = [
  'Junior',
  'Mid-Level',
  'Senior',
  'Executive',
  'C-Suite',
]

const MEET_ROLE_TYPES = [
  'Executive / C-Suite',
  'Investor / VC',
  'Government / Policy',
  'Finance',
  'Healthcare',
  'Legal',
]

const PURPOSES = [
  'Fundraising',
  'Hiring',
  'Partnerships',
  'Mentorship',
  'Business Development',
  'Advice / Expertise',
  'Networking',
]

type Step = 'password' | 'profile' | 'preferences'

// `needsPassword` is REQUIRED (no default) so every caller must decide explicitly and fail closed —
// it is the server-confirmed gate: only a genuine legacy temp-password account (flag true, password
// not yet server-confirmed) starts at the password step; everyone else starts at the profile step.
export default function OnboardingForm({ initialFullName = '', needsPassword }: { initialFullName?: string; needsPassword: boolean }) {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Location is required to finish onboarding. Its error is rendered next to the
  // field (not only in the shared banner) and the input is focused on failure, so
  // keyboard and screen-reader users are taken straight to what needs fixing.
  const cityInputRef = useRef<HTMLInputElement>(null)
  const [locationError, setLocationError] = useState<string | null>(null)

  const [step, setStep] = useState<Step>(initialOnboardingStep(needsPassword))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Password step
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  // Profile step
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [fullName, setFullName] = useState(initialFullName)
  const [title, setTitle] = useState('')
  const [company, setCompany] = useState('')
  const [currentStatus, setCurrentStatus] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [roleType, setRoleType] = useState('')
  const [exactJobTitle, setExactJobTitle] = useState<string | null>(null)
  const [seniority, setSeniority] = useState('')
  // Fresh-onboarding only — this form does not receive a profile prop, so
  // existing expertise (legacy or canonical) is never loaded. The other three
  // forms (OnboardingStep1, ProfileForm, ProfileEditForm) split state into
  // canonical + additional via parseExpertise; here all selections start empty
  // and the user picks fresh. completeOnboarding's upsert sets profiles.expertise
  // to whatever is selected — no legacy tags to preserve because none can exist
  // in component state at submit time.
  const [expertise, setExpertise] = useState<string[]>([])
  const [bio, setBio] = useState('')

  // Preferences step
  const [meetRoles, setMeetRoles] = useState<string[]>([])
  const [purposes, setPurposes] = useState<string[]>([])
  const [desiredConnections, setDesiredConnections] = useState<CategoryTitleSelection>({})
  const [meetingFormat, setMeetingFormat] = useState('both')
  const [geographicScope, setGeographicScope] = useState('us-wide')
  const [lookingFor, setLookingFor] = useState('')
  const [focusAreas, setFocusAreas] = useState<string[]>([])

  const toggleItem = (list: string[], setList: (v: string[]) => void, item: string) => {
    setList(list.includes(item) ? list.filter(i => i !== item) : [...list, item])
  }

  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (newPassword.length < 8) { setError('Password must be at least 8 characters'); return }
    if (newPassword !== confirmPassword) { setError('Passwords do not match'); return }
    setSaving(true)
    // Reuse the SERVER-AUTHORIZED reset completion path: it updates the password server-side AND
    // clears password_reset_required in the same request (issuing a signed continuation cookie).
    // This clears the flag IMMEDIATELY — not only at the end of onboarding — so a refresh can never
    // re-show this password form and reject the same password. No client-authorized flag clear.
    const res = await fetch('/api/auth/complete-reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'set', password: newPassword }),
    })
    const data = await res.json().catch(() => ({} as any))
    setSaving(false)
    // ok → flag cleared; finalize → password set but flag-clear deferred (a valid continuation
    // cookie was issued, which the onboarding page honors on refresh). Both mean the password is set.
    if (data?.ok || data?.stage === 'finalize') { setNewPassword(''); setConfirmPassword(''); setStep('profile'); return }
    setError(data?.message || 'Could not set your password. Please try again.')
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setAvatarFile(file)
    const reader = new FileReader()
    reader.onloadend = () => setAvatarPreview(reader.result as string)
    reader.readAsDataURL(file)
  }

  // Mirrors completeOnboarding's derivation EXACTLY, so what the member sees
  // validated here is the same string the server validates and stores.
  const derivedLocation = () => {
    const c = city.trim(), s = state.trim()
    return c && s ? `${c}, ${s}` : c || s || ''
  }

  /** Client-side location gate. UX only — the server re-validates and is authoritative. */
  const checkLocation = (): boolean => {
    const check = validateLocation(derivedLocation())
    if (!check.ok) {
      setLocationError(check.error)
      setError(check.error)
      cityInputRef.current?.focus()
      return false
    }
    setLocationError(null)
    return true
  }

  const handleProfileNext = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValidFullName(fullName)) { setError(FULL_NAME_ERROR); return }
    if (title.trim().length < 2) { setError('Please enter your title or role'); return }
    if (!isEmploymentStatus(currentStatus)) { setError('Please choose your employment status'); return }
    // 'Currently employed' is the only status that requires an organisation. The others may leave
    // it blank, so the old unconditional company check would have blocked them.
    if (currentStatus === 'employed' && company.trim().length < 2) {
      setError('Please enter the organisation you work for'); return
    }
    {
      // The SAME verdict the server will reach — surfaced here so the member is not sent to the
      // submit button to find out.
      const v = previewCompatibility({ role_type: roleType, current_status: currentStatus, company: company.trim() })
      if (!v.ok) { setError(v.message); return }
    }
    if (!checkLocation()) return
    if (!roleType.trim()) { setError('Please select your professional role'); return }
    if (!seniority.trim()) { setError('Please select your seniority level'); return }
    if (expertise.filter(Boolean).length === 0) { setError('Please select at least one area of expertise'); return }
    setError(null)
    setStep('preferences')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    console.log('[OnboardingForm] handleSubmit called!')
    // Defense-in-depth: handleProfileNext should have gated these, but state
    // could be cleared between steps. Catch here before sending to the server.
    if (!isValidFullName(fullName)) { setError(FULL_NAME_ERROR); return }
    if (title.trim().length < 2) { setError('Please enter your title or role'); return }
    if (!isEmploymentStatus(currentStatus)) { setError('Please choose your employment status'); return }
    // 'Currently employed' is the only status that requires an organisation. The others may leave
    // it blank, so the old unconditional company check would have blocked them.
    if (currentStatus === 'employed' && company.trim().length < 2) {
      setError('Please enter the organisation you work for'); return
    }
    {
      // The SAME verdict the server will reach — surfaced here so the member is not sent to the
      // submit button to find out.
      const v = previewCompatibility({ role_type: roleType, current_status: currentStatus, company: company.trim() })
      if (!v.ok) { setError(v.message); return }
    }
    // Location can only have been entered on the previous step, so send the member
    // back there rather than showing an error next to a field they cannot see.
    const locationCheck = validateLocation(derivedLocation())
    if (!locationCheck.ok) {
      setLocationError(locationCheck.error)
      setError(locationCheck.error)
      setStep('profile')
      return
    }
    if (!roleType.trim()) { setError('Please select your professional role'); return }
    if (!seniority.trim()) { setError('Please select your seniority level'); return }
    if (expertise.filter(Boolean).length === 0) { setError('Please select at least one area of expertise'); return }
    setSaving(true)
    setError(null)

    let avatarUrl: string | null = null
    if (avatarFile) {
      try {
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (user) {
          const ext = avatarFile.name.split('.').pop() ?? 'jpg'
          const path = `${user.id}.${ext}`
          const { error: uploadError } = await supabase.storage.from('avatars').upload(path, avatarFile, { upsert: true })
          if (!uploadError) {
            const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(path)
            avatarUrl = urlData.publicUrl
          }
        }
      } catch (err) {
        console.warn('[onboarding] avatar upload threw:', err)
      }
    }

    const fd = new FormData()
    fd.append('full_name', fullName.trim())
    fd.append('title', title.trim())
    fd.append('company', company.trim())
    fd.append('current_status', currentStatus)
    fd.append('city', city.trim())
    fd.append('state', state.trim())
    fd.append('role_type', roleType)
    fd.append('exact_job_title', exactJobTitle ?? '')
    fd.append('seniority', seniority)
    fd.append('expertise', expertise.join(','))
    fd.append('bio', bio.trim())
    fd.append('looking_for', lookingFor.trim())
    fd.append('intro_preferences', meetRoles.join(','))
    fd.append('purposes', purposes.join(','))
    fd.append('desired_connections', JSON.stringify(desiredConnections))
    fd.append('meeting_format_preference', meetingFormat)
    fd.append('geographic_scope', geographicScope)
    fd.append('current_focus_areas', JSON.stringify(focusAreas))
    if (avatarUrl) fd.append('avatar_url', avatarUrl)

    // Everything below runs inside a SUBMIT EVENT HANDLER. React error boundaries do not
    // catch event-handler exceptions or rejected promises, so app/onboarding/error.tsx
    // would NOT contain a failure here — an unhandled rejection would leave the member
    // staring at a spinner (or worse) with no idea whether their profile was saved. Handle
    // it locally: surface a retryable message and re-enable the form. The profile write
    // itself already happened server-side before any of this can fail.
    try {
      console.log('[OnboardingForm] About to call completeOnboarding')
      const result = await completeOnboarding(fd)
      console.log('[OnboardingForm] completeOnboarding returned:', result)
      if (result?.error) { setError(result.error); setSaving(false); return }

      // Wait a moment for recommendations to finish generating
      await new Promise(resolve => setTimeout(resolve, 1000))

      router.push('/dashboard/introductions')
    } catch (err) {
      // Never swallowed silently: logged locally, and the member gets an explicit,
      // accurate next step rather than a dead form. Their answers stay in component state,
      // so "Try again" re-submits exactly what they entered.
      console.error('[OnboardingForm] submit failed', err)
      setError(
        'We couldn’t finish setting up your profile. Your answers are still here — please try again. ' +
        'If it keeps failing, open your introductions page; your profile may already be saved.',
      )
      setSaving(false)
    }
  }

  const steps = onboardingStepList(needsPassword)
  const stepIndex = steps.indexOf(step)

  return (
    <div className="min-h-screen bg-[#F5F6FB] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-xl">

        <div className="text-center mb-8">
          <span className="text-2xl font-bold text-[#1B2850] tracking-tight block mb-6">Andrel</span>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">
            {step === 'password' ? 'Set your password' : step === 'profile' ? 'Complete your profile' : 'Who do you want to meet?'}
          </h1>
          <p className="text-slate-500 text-sm">
            {step === 'password' ? 'Create a secure password to protect your Andrel account.' :
             step === 'profile' ? 'Tell us about yourself so we can match you with the right people.' :
             'Help us find the right introductions for you.'}
          </p>
        </div>

        {/* Step indicator — one dot per active step (the password step is omitted when not needed). */}
        <div className="flex items-center justify-center gap-2 mb-6">
          {steps.map((_, i) => (
            <div key={i} className={cn('h-1.5 w-14 rounded-full transition-colors',
              i < stepIndex ? 'bg-[#C4922A]' : i === stepIndex ? 'bg-[#1B2850]' : 'bg-slate-200'
            )} />
          ))}
        </div>

        {step === 'password' && (
          <form onSubmit={handleSetPassword} className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 space-y-5">
            <RequiredLegend />
            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-1.5">New password<RequiredMark /></label>
              <div className="relative">
                <input type={showNew ? 'text' : 'password'} value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="At least 8 characters" required className="w-full px-3.5 py-2.5 pr-10 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition" />
                <button type="button" onClick={() => setShowNew(!showNew)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-1.5">Confirm password<RequiredMark /></label>
              <div className="relative">
                <input type={showConfirm ? 'text' : 'password'} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Re-enter your password" required className="w-full px-3.5 py-2.5 pr-10 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition" />
                <button type="button" onClick={() => setShowConfirm(!showConfirm)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 px-4 py-3 rounded-lg">{error}</p>}
            <button type="submit" disabled={saving} className="w-full flex items-center justify-center gap-2 bg-[#1B2850] text-white text-sm font-semibold px-6 py-3 rounded-lg hover:bg-[#162040] transition-colors disabled:opacity-60">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {saving ? 'Setting password...' : 'Set Password & Continue →'}
            </button>
          </form>
        )}

        {step === 'profile' && (
          <form onSubmit={handleProfileNext} className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 space-y-5">
            <RequiredLegend />
            <div className="flex flex-col items-center gap-2 pb-1">
              <button type="button" onClick={() => fileInputRef.current?.click()} className="relative w-20 h-20 rounded-full bg-slate-100 border-2 border-dashed border-slate-300 hover:border-[#1B2850] transition-colors flex items-center justify-center overflow-hidden group">
                {avatarPreview ? <Image src={avatarPreview} alt="Preview" fill className="object-cover" /> : <User className="w-8 h-8 text-slate-300" />}
                <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded-full"><Camera className="w-5 h-5 text-white" /></div>
              </button>
              <button type="button" onClick={() => fileInputRef.current?.click()} className="text-xs text-[#1B2850] font-medium hover:underline">{avatarPreview ? 'Change photo' : 'Upload profile photo'}</button>
              <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-1.5">Full name<RequiredMark /></label>
              <input type="text" value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Jane Smith" required className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition" />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-1.5">
                {employmentStatusOption(currentStatus)?.companyLabel ?? 'Company or organization'}
                {currentStatus === 'employed' && <RequiredMark />}
              </label>
              <input type="text" value={company} onChange={e => setCompany(e.target.value)} placeholder="Acme Corp" className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition" />
            </div>
            
            {/*
              Location is required to finish onboarding. Kept as City + a second
              free-text box (rather than one input) because profiles.city feeds the
              same-city matching signal — but the second box accepts a state, region
              OR country, so no international member is forced into a US state.
            */}
            <fieldset aria-describedby="onboarding-location-help">
              <legend className="block text-sm font-semibold text-slate-800 mb-1.5">
                Location<RequiredMark />
              </legend>
              <p id="onboarding-location-help" className="text-xs text-slate-500 mb-2">
                {LOCATION_HELP_TEXT} For example: New York, NY · London, UK · Singapore.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="onboarding-city" className="block text-xs font-medium text-slate-600 mb-1">City</label>
                  <input
                    id="onboarding-city"
                    ref={cityInputRef}
                    type="text"
                    value={city}
                    onChange={e => { setCity(e.target.value); if (locationError) setLocationError(null) }}
                    placeholder="New York"
                    required
                    aria-required="true"
                    aria-invalid={locationError ? true : undefined}
                    aria-describedby={locationError ? 'onboarding-location-error' : undefined}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition"
                  />
                </div>
                <div>
                  <label htmlFor="onboarding-region" className="block text-xs font-medium text-slate-600 mb-1">
                    State, region, or country
                  </label>
                  <input
                    id="onboarding-region"
                    type="text"
                    value={state}
                    onChange={e => { setState(e.target.value); if (locationError) setLocationError(null) }}
                    placeholder="NY, UK, or Singapore"
                    aria-invalid={locationError ? true : undefined}
                    aria-describedby={locationError ? 'onboarding-location-error' : undefined}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition"
                  />
                </div>
              </div>
              {locationError && (
                <p id="onboarding-location-error" role="alert" className="mt-1.5 text-xs text-red-600">
                  {locationError}
                </p>
              )}
            </fieldset>

            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-2">Role title<RequiredMark /></label>
              <SearchableTitleSelect
                roleType={roleType}
                exactJobTitle={exactJobTitle}
                onChange={({ role_type, exact_job_title, title }) => {
                  setRoleType(role_type)
                  setExactJobTitle(exact_job_title)
                  setTitle(title)
                }}
              />
              {/* Optional recruiter framing. Renders only for the two recruiter role_type values,
                  stores nothing of its own, and therefore cannot block completion or lose an
                  answer when the member changes role. */}
              <RecruiterGuidancePanel roleType={roleType} />
            </div>

            <EmploymentStatusField
              value={currentStatus}
              onChange={setCurrentStatus}
              roleType={roleType}
              company={company}
              idPrefix="onb-employment-status"
            />

            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-2">Seniority level<RequiredMark /></label>
              <div className="flex flex-wrap gap-2">
                {SENIORITY_LEVELS.map(level => (
                  <button key={level} type="button" onClick={() => setSeniority(level === seniority ? '' : level)} className={cn('px-3.5 py-2 rounded-lg text-sm font-medium border transition-all', seniority === level ? 'bg-[#1B2850] text-white border-[#1B2850]' : 'bg-white text-slate-600 border-slate-200 hover:border-[#1B2850]/40 hover:text-[#1B2850]')}>{level}</button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-2">Areas of expertise<RequiredMark /> <span className="text-slate-400 font-normal text-xs ml-1">type to search; select multiple</span></label>
              <SearchableExpertiseSelect selected={expertise} onChange={setExpertise} />
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-1.5">Short bio</label>
              <textarea value={bio} onChange={e => setBio(e.target.value)} placeholder="A few sentences about your background and what you bring to the table." rows={3} className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition resize-none" />
            </div>

            {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 px-4 py-3 rounded-lg">{error}</p>}
            <button type="submit" className="w-full flex items-center justify-center gap-2 bg-[#1B2850] text-white text-sm font-semibold px-6 py-3 rounded-lg hover:bg-[#162040] transition-colors">
              Continue →
            </button>
          </form>
        )}

        {step === 'preferences' && (
          <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 space-y-6">
            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-2">Who do you want to meet? <span className="text-slate-400 font-normal text-xs">optional</span></label>
              <div className="flex flex-wrap gap-2">
                {MEET_ROLE_TYPES.map(rt => (
                  <button key={rt} type="button" onClick={() => toggleItem(meetRoles, setMeetRoles, rt)} className={cn('px-3.5 py-2 rounded-lg text-sm font-medium border transition-all', meetRoles.includes(rt) ? 'bg-[#1B2850] text-white border-[#1B2850]' : 'bg-white text-slate-600 border-slate-200 hover:border-[#1B2850]/40 hover:text-[#1B2850]')}>{rt}</button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-2">Specific connections <span className="text-slate-400 font-normal text-xs">optional</span></label>
              <p className="text-xs text-slate-500 mb-2">Pick categories or specific titles. Tap a category to choose &ldquo;Anyone&rdquo; or specific titles.</p>
              <ConnectionTargetPicker value={desiredConnections} onChange={setDesiredConnections} />
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-2">What's the purpose? <span className="text-slate-400 font-normal text-xs">optional</span></label>
              <div className="flex flex-wrap gap-2">
                {PURPOSES.map(p => (
                  <button key={p} type="button" onClick={() => toggleItem(purposes, setPurposes, p)} className={cn('px-3.5 py-2 rounded-lg text-sm font-medium border transition-all', purposes.includes(p) ? 'bg-[#C4922A] text-white border-[#C4922A]' : 'bg-white text-slate-600 border-slate-200 hover:border-[#C4922A]/40 hover:text-[#C4922A]')}>{p}</button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-2">Meeting format preference</label>
              <div className="flex gap-2">
                {[
                  { value: 'virtual', label: 'Virtual only' },
                  { value: 'in-person', label: 'In-person only' },
                  { value: 'both', label: 'Either works' },
                ].map(option => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setMeetingFormat(option.value)}
                    className={cn(
                      'flex-1 px-3.5 py-2.5 rounded-lg text-sm font-medium border transition-all',
                      meetingFormat === option.value
                        ? 'bg-[#1B2850] text-white border-[#1B2850]'
                        : 'bg-white text-slate-600 border-slate-200 hover:border-[#1B2850]/40 hover:text-[#1B2850]'
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-2">Geographic preference</label>
              <div className="flex gap-2">
                {[
                  { value: 'local', label: 'Local connections only' },
                  { value: 'us-wide', label: 'Open to connections anywhere' },
                ].map(option => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setGeographicScope(option.value)}
                    className={cn(
                      'flex-1 px-3.5 py-2.5 rounded-lg text-sm font-medium border transition-all',
                      geographicScope === option.value
                        ? 'bg-[#1B2850] text-white border-[#1B2850]'
                        : 'bg-white text-slate-600 border-slate-200 hover:border-[#1B2850]/40 hover:text-[#1B2850]'
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-1.5">
                Anything else? <span className="text-slate-400 font-normal text-xs">optional</span>
              </label>
              <textarea value={lookingFor} onChange={e => setLookingFor(e.target.value)} placeholder="e.g. Looking for a Series A lead, want to connect with healthcare operators in NYC..." rows={3} className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition resize-none" />
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-1">Current focus areas <span className="text-slate-400 font-normal text-xs">optional</span></label>
              <p className="text-xs text-slate-500 mb-2">Topics, technologies, industries, or policy areas especially relevant to you right now. These can change over time.</p>
              <CurrentFocusAreasInput compact onChange={setFocusAreas} />
            </div>

            {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 px-4 py-3 rounded-lg">{error}</p>}

            <div className="flex gap-3">
              <button type="button" onClick={() => setStep('profile')} className="flex-1 px-6 py-3 rounded-lg text-sm font-semibold border border-slate-200 text-slate-600 hover:border-slate-300 transition-colors">
                ← Back
              </button>
              <button type="submit" disabled={saving} className="flex-2 w-full flex items-center justify-center gap-2 bg-[#C4922A] text-white text-sm font-semibold px-6 py-3 rounded-lg hover:bg-[#b07e21] transition-colors disabled:opacity-60">
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {saving ? 'Saving...' : 'Enter Andrel →'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
// Force rebuild Wed Apr 15 12:04:32 EDT 2026
