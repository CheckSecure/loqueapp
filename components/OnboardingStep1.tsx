'use client'

import { useState } from 'react'
import { normalizeExpertise } from '@/lib/expertise'
import SearchableTitleSelect from '@/components/SearchableTitleSelect'
import SearchableExpertiseSelect from '@/components/SearchableExpertiseSelect'
import { Loader2, ArrowRight } from 'lucide-react'
import { Linkedin, Twitter, Link as LinkIcon } from 'lucide-react'
import AvatarUpload from '@/components/AvatarUpload'

interface Profile {
  id: string
  full_name?: string
  title?: string
  company?: string
  location?: string
  bio?: string
  expertise?: string[]
  linkedin_url?: string
  twitter_url?: string
  website_url?: string
  avatar_url?: string | null
  seniority?: string
  role_type?: string
  exact_job_title?: string | null
  mentorship_role?: string
  current_status?: string
}

export default function OnboardingStep1({ 
  profile, 
  email, 
  onNext 
}: { 
  profile: Profile | null
  email: string
  onNext: () => void 
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Unified: every previously-saved value loads into one removable selected list.
  const [expertise, setExpertise] = useState<string[]>(normalizeExpertise(profile?.expertise))
  const [roleType, setRoleType] = useState<string>(profile?.role_type || '')
  const [exactJobTitle, setExactJobTitle] = useState<string | null>(profile?.exact_job_title ?? null)
  // Derived from the role-title selector (selected role label, or custom role
  // text for 'Other'). Kept populated so the server-side title validation in
  // /api/profile/complete continues to pass.
  const [title, setTitle] = useState<string>(profile?.title || '')

  const initials = (profile?.full_name || email)
    .split(' ').map((n: string) => n[0]).slice(0, 2).join('').toUpperCase()

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    // Role title is required; its derived title must survive the server-side
    // title validation (>= 2 visible chars). For 'Other', the derived title is
    // the custom role text — enforce the same rule client-side here.
    if (!roleType.trim()) { setError('Please select your role title'); setLoading(false); return }
    if (title.trim().length < 2) {
      setError(roleType === 'Other' ? 'Please enter your custom role title' : 'Please select your role title')
      setLoading(false)
      return
    }

    const formData = new FormData(e.currentTarget)
    formData.set('expertise', expertise.join(','))
    formData.set('role_type', roleType)
    // Derived title (selected role label, or custom role text for 'Other').
    // The standalone free-text title input was removed, so set it explicitly.
    formData.set('title', title.trim())
    // Always send exact_job_title so the server can distinguish "absent"
    // (partial update — leave alone) from "explicit clear" (empty → null).
    formData.set('exact_job_title', exactJobTitle ?? '')
    
    const response = await fetch('/api/profile/update', {
      method: 'POST',
      body: formData
    })

    const result = await response.json()
    setLoading(false)

    if (result.error) {
      setError(result.error)
    } else {
      await fetch('/api/profile/onboarding-step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 2 })
      })
      onNext()
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Avatar */}
      <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden">
        <div className="h-20 bg-gradient-to-r from-[#1B2850] to-[#2E4080]" />
        <div className="px-6 pb-6">
          <div className="-mt-10 mb-4">
            <AvatarUpload userId={profile?.id || ''} displayName={profile?.full_name || email} />
          </div>
        </div>
      </div>

      {/* Basic info */}
      <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-6 space-y-4">
        <h3 className="text-sm font-semibold text-slate-900">Basic information</h3>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Full name</label>
          <input
            name="full_name"
            type="text"
            defaultValue={profile?.full_name || ''}
            placeholder="Jane Smith"
            className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition"
            required
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Company or organization</label>
          <input
            name="company"
            type="text"
            defaultValue={profile?.company || ''}
            placeholder="Acme Corp, Independent, Self-employed, Retired, or Between roles"
            className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition"
            required
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Location</label>
          <input
            name="location"
            type="text"
            defaultValue={profile?.location || ''}
            placeholder="San Francisco, CA"
            className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Bio</label>
          <textarea
            name="bio"
            rows={3}
            defaultValue={profile?.bio || ''}
            placeholder="Tell your professional story..."
            className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition resize-none"
            required
          />
        </div>
      </div>

      {/* Professional details */}
      <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-6 space-y-4">
        <h3 className="text-sm font-semibold text-slate-900">Professional details</h3>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Seniority</label>
          <select
            name="seniority"
            defaultValue={profile?.seniority || ''}
            className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition bg-white"
          >
            <option value="">Select seniority</option>
            <option value="Junior">Junior</option>
            <option value="Mid-level">Mid-level</option>
            <option value="Senior">Senior</option>
            <option value="Executive">Executive</option>
            <option value="C-Suite">C-Suite</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Role title</label>
          <SearchableTitleSelect
            roleType={roleType}
            exactJobTitle={exactJobTitle}
            onChange={({ role_type, exact_job_title, title }) => {
              setRoleType(role_type)
              setExactJobTitle(exact_job_title)
              setTitle(title)
            }}
          />
        </div>
      </div>

      {/* Expertise */}
      <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-6">
        <h3 className="text-sm font-semibold text-slate-900 mb-1">Expertise</h3>
        <p className="text-xs text-slate-400 mb-3">Type to search; select multiple areas of expertise.</p>
        <SearchableExpertiseSelect
          selected={expertise}
          onChange={setExpertise}
        />
      </div>

      {/* Links */}
      <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-6 space-y-4">
        <h3 className="text-sm font-semibold text-slate-900">Links (optional)</h3>
        {[
          { icon: Linkedin, name: 'linkedin_url', label: 'LinkedIn URL', placeholder: 'https://linkedin.com/in/yourprofile' },
          { icon: Twitter, name: 'twitter_url', label: 'Twitter / X', placeholder: 'https://twitter.com/yourhandle' },
          { icon: LinkIcon, name: 'website_url', label: 'Personal site', placeholder: 'https://yourwebsite.com' },
        ].map(({ icon: Icon, name, label, placeholder }) => (
          <div key={name} className="flex items-center gap-3">
            <div className="w-8 h-8 bg-slate-50 border border-slate-100 rounded-lg flex items-center justify-center flex-shrink-0">
              <Icon className="w-4 h-4 text-slate-400" />
            </div>
            <input
              name={name}
              type="url"
              defaultValue={(profile as any)?.[name] || ''}
              placeholder={placeholder}
              className="flex-1 px-3.5 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition"
            />
          </div>
        ))}
      </div>

      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 px-4 py-3 rounded-lg">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="w-full flex items-center justify-center gap-2 bg-[#1B2850] text-white text-sm font-semibold px-6 py-3 rounded-lg hover:bg-[#2E4080] transition-colors disabled:opacity-60"
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
        {loading ? 'Saving...' : 'Continue to Preferences'}
      </button>
    </form>
  )
}
