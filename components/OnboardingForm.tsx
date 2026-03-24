'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { completeOnboarding } from '@/app/actions'
import { Loader2, User, Camera, Eye, EyeOff } from 'lucide-react'
import Image from 'next/image'
import { cn } from '@/lib/utils'

const ROLE_TYPES = [
  'Executive / C-Suite',
  'Investor / VC',
  'Government / Policy',
  'Finance',
  'Healthcare',
  'Legal',
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
]

type Step = 'password' | 'profile' | 'preferences'

export default function OnboardingForm() {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState<Step>('password')
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
  const [fullName, setFullName] = useState('')
  const [title, setTitle] = useState('')
  const [company, setCompany] = useState('')
  const [roleType, setRoleType] = useState('')
  const [bio, setBio] = useState('')

  // Preferences step
  const [meetRoles, setMeetRoles] = useState<string[]>([])
  const [purposes, setPurposes] = useState<string[]>([])
  const [lookingFor, setLookingFor] = useState('')

  const toggleItem = (list: string[], setList: (v: string[]) => void, item: string) => {
    setList(list.includes(item) ? list.filter(i => i !== item) : [...list, item])
  }

  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (newPassword.length < 8) { setError('Password must be at least 8 characters'); return }
    if (newPassword !== confirmPassword) { setError('Passwords do not match'); return }
    setSaving(true)
    const supabase = createClient()
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword })
    setSaving(false)
    if (updateError) { setError(updateError.message); return }
    setStep('profile')
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setAvatarFile(file)
    const reader = new FileReader()
    reader.onloadend = () => setAvatarPreview(reader.result as string)
    reader.readAsDataURL(file)
  }

  const handleProfileNext = (e: React.FormEvent) => {
    e.preventDefault()
    if (!fullName.trim()) { setError('Full name is required'); return }
    setError(null)
    setStep('preferences')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
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
    fd.append('role_type', roleType)
    fd.append('bio', bio.trim())
    fd.append('looking_for', lookingFor.trim())
    fd.append('intro_preferences', meetRoles.join(','))
    fd.append('purposes', purposes.join(','))
    if (avatarUrl) fd.append('avatar_url', avatarUrl)

    const result = await completeOnboarding(fd)
    if (result.error) { setError(result.error); setSaving(false); return }
    router.push('/dashboard/introductions')
  }

  const stepIndex = step === 'password' ? 0 : step === 'profile' ? 1 : 2

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

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 mb-6">
          {[0, 1, 2].map(i => (
            <div key={i} className={cn('h-1.5 w-14 rounded-full transition-colors',
              i < stepIndex ? 'bg-[#C4922A]' : i === stepIndex ? 'bg-[#1B2850]' : 'bg-slate-200'
            )} />
          ))}
        </div>

        {step === 'password' && (
          <form onSubmit={handleSetPassword} className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 space-y-5">
            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-1.5">New password <span className="text-red-500">*</span></label>
              <div className="relative">
                <input type={showNew ? 'text' : 'password'} value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="At least 8 characters" required className="w-full px-3.5 py-2.5 pr-10 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition" />
                <button type="button" onClick={() => setShowNew(!showNew)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-1.5">Confirm password <span className="text-red-500">*</span></label>
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
            <div className="flex flex-col items-center gap-2 pb-1">
              <button type="button" onClick={() => fileInputRef.current?.click()} className="relative w-20 h-20 rounded-full bg-slate-100 border-2 border-dashed border-slate-300 hover:border-[#1B2850] transition-colors flex items-center justify-center overflow-hidden group">
                {avatarPreview ? <Image src={avatarPreview} alt="Preview" fill className="object-cover" /> : <User className="w-8 h-8 text-slate-300" />}
                <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded-full"><Camera className="w-5 h-5 text-white" /></div>
              </button>
              <button type="button" onClick={() => fileInputRef.current?.click()} className="text-xs text-[#1B2850] font-medium hover:underline">{avatarPreview ? 'Change photo' : 'Upload profile photo'}</button>
              <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-1.5">Full name <span className="text-red-500">*</span></label>
              <input type="text" value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Jane Smith" required className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition" />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-1.5">Title / Role</label>
              <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="Chief Executive Officer" className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition" />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-1.5">Company</label>
              <input type="text" value={company} onChange={e => setCompany(e.target.value)} placeholder="Acme Corp" className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition" />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-2">Role type</label>
              <div className="flex flex-wrap gap-2">
                {ROLE_TYPES.map(rt => (
                  <button key={rt} type="button" onClick={() => setRoleType(rt === roleType ? '' : rt)} className={cn('px-3.5 py-2 rounded-lg text-sm font-medium border transition-all', roleType === rt ? 'bg-[#1B2850] text-white border-[#1B2850]' : 'bg-white text-slate-600 border-slate-200 hover:border-[#1B2850]/40 hover:text-[#1B2850]')}>{rt}</button>
                ))}
              </div>
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
              <label className="block text-sm font-semibold text-slate-800 mb-2">What's the purpose? <span className="text-slate-400 font-normal text-xs">optional</span></label>
              <div className="flex flex-wrap gap-2">
                {PURPOSES.map(p => (
                  <button key={p} type="button" onClick={() => toggleItem(purposes, setPurposes, p)} className={cn('px-3.5 py-2 rounded-lg text-sm font-medium border transition-all', purposes.includes(p) ? 'bg-[#C4922A] text-white border-[#C4922A]' : 'bg-white text-slate-600 border-slate-200 hover:border-[#C4922A]/40 hover:text-[#C4922A]')}>{p}</button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-1.5">
                Anything else? <span className="text-slate-400 font-normal text-xs">optional</span>
              </label>
              <textarea value={lookingFor} onChange={e => setLookingFor(e.target.value)} placeholder="e.g. Looking for a Series A lead, want to connect with healthcare operators in NYC..." rows={3} className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition resize-none" />
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
