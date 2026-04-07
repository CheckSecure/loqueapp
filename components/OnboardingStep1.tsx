'use client'
// Force rebuild

import { useState } from 'react'
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
  mentorship_role?: string
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

  const initials = (profile?.full_name || email)
    .split(' ').map((n: string) => n[0]).slice(0, 2).join('').toUpperCase()

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const formData = new FormData(e.currentTarget)
    
    const response = await fetch('/api/profile/update', {
      method: 'POST',
      body: formData
    })

    const result = await response.json()
    setLoading(false)

    if (result.error) {
      setError(result.error)
    } else {
      // Update onboarding step
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
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Job title</label>
            <input
              name="title"
              type="text"
              defaultValue={profile?.title || ''}
              placeholder="VP & General Counsel"
              className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Company</label>
            <input
              name="company"
              type="text"
              defaultValue={profile?.company || ''}
              placeholder="Acme Inc."
              className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition"
              required
            />
          </div>
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
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Seniority</label>
            <input
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
            <select
              name="role_type"
              defaultValue={profile?.role_type || ''}
              className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition bg-white"
            >
              <option value="">Select role type</option>
              <option value="In-house Counsel">In-house Counsel</option>
              <option value="Law Firm Attorney">Law Firm Attorney</option>
              <option value="Legal Operations">Legal Operations</option>
              <option value="Compliance">Compliance</option>
              <option value="Other">Other</option>
            </select>
          </div>
        </div>
      </div>

      {/* Expertise */}
      <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-6">
        <h3 className="text-sm font-semibold text-slate-900 mb-1">Expertise</h3>
        <p className="text-xs text-slate-400 mb-3">Comma-separated list of your areas of expertise.</p>
        <input
          name="expertise"
          type="text"
          defaultValue={Array.isArray(profile?.expertise) ? profile.expertise.join(', ') : ''}
          placeholder="M&A, Securities Law, Corporate Governance"
          className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition"
          required
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
