'use client'

import { useState } from 'react'
import { serializeMultiSelectField } from '@/lib/profile/multiSelect'
import { normalizeExpertise } from '@/lib/expertise'
import { type CategoryTitleSelection } from '@/lib/role-taxonomy'
import ConnectionTargetPicker from '@/components/ConnectionTargetPicker'
import SearchableTitleSelect from '@/components/SearchableTitleSelect'
import SearchableExpertiseSelect from '@/components/SearchableExpertiseSelect'
import { Linkedin, Twitter, Link as LinkIcon, Loader2, CheckCircle } from 'lucide-react'
import { updateProfile } from '@/app/actions'
import AvatarUpload from '@/components/AvatarUpload'

interface Profile {
  id: string
  full_name?: string
  title?: string
  company?: string
  location?: string
  bio?: string
  expertise?: string[]
  intro_preferences?: string[]
  purposes?: string[]
  interests?: string[]
  desired_connections?: CategoryTitleSelection
  linkedin_url?: string
  twitter_url?: string
  website_url?: string
  avatar_url?: string | null
  seniority?: string
  role_type?: string
  exact_job_title?: string | null
  mentorship_role?: string
}

const INTRO_PREFS = ['Investors', 'Founders', 'Potential hires', 'Collaborators', 'Mentors', 'Customers']
const PURPOSE_OPTIONS = ["Find customers", "Raise capital", "Hire talent", "Learn & grow", "Expand network", "Give back / mentor", "Explore opportunities"]
const INTEREST_OPTIONS = ["Sports", "Travel", "Food & wine", "Arts & culture", "Technology", "Fitness", "Reading", "Music", "Volunteering"]

export default function ProfileForm({ profile, email }: { profile: Profile | null; email: string }) {
  const [loading, setLoading] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [introPref, setIntroPref] = useState<string[]>(profile?.intro_preferences || [])
  const [purposes, setPurposes] = useState<string[]>(profile?.purposes || [])
  const [interests, setInterests] = useState<string[]>(profile?.interests || [])
  const [desiredConnections, setDesiredConnections] = useState<CategoryTitleSelection>(profile?.desired_connections || {})
  const [roleType, setRoleType] = useState<string>(profile?.role_type || '')
  const [exactJobTitle, setExactJobTitle] = useState<string | null>(profile?.exact_job_title ?? null)
  // Unified: every previously-saved value loads into one removable selected list.
  const [expertise, setExpertise] = useState<string[]>(normalizeExpertise(profile?.expertise))
  const toggleExpertise = (item: string) => {
    setExpertise(prev => prev.includes(item) ? prev.filter(x => x !== item) : [...prev, item])
  }

  const initials = (profile?.full_name || email)
    .split(' ').map((n: string) => n[0]).slice(0, 2).join('').toUpperCase()

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setLoading(true)
    setSaved(false)
    setError(null)
    const formData = new FormData(e.currentTarget)
    formData.set('intro_preferences', introPref.join(','))
    formData.set('purposes', serializeMultiSelectField(purposes))
    formData.set('interests', serializeMultiSelectField(interests))
    formData.set('expertise', expertise.join(','))
    formData.set('role_type', roleType)
    // Always send exact_job_title (empty string = clear). Server treats "" as null.
    formData.set('exact_job_title', exactJobTitle ?? '')
    formData.set('desired_connections', JSON.stringify(desiredConnections))
    const result = await updateProfile(formData)
    setLoading(false)
    if (result.error) {
      setError(result.error)
    } else {
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Avatar + status */}
      <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden">
        <div className="h-20 bg-gradient-to-r from-[#1B2850] to-[#2E4080]" />
        <div className="px-6 pb-6">
          <div className="flex items-end justify-between">
            {profile?.id && (
              <AvatarUpload
                userId={profile.id}
                initialAvatarUrl={profile?.avatar_url}
                displayName={profile?.full_name || email}
              />
            )}
          </div>
          <p className="text-xs text-slate-400 mt-1">{email}</p>
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
          />
        </div>
      </div>

      {/* Professional details */}
      <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-6 space-y-4">
        <h3 className="text-sm font-semibold text-slate-900">Professional details</h3>
        <p className="text-xs text-slate-400 -mt-1">Used to match you with relevant introductions.</p>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Seniority</label>
            <input
              name="seniority"
              type="text"
              defaultValue={profile?.seniority || ''}
              placeholder="Executive"
              className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Mentorship role</label>
            <input
              name="mentorship_role"
              type="text"
              defaultValue={profile?.mentorship_role || ''}
              placeholder="Mentor"
              className="w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Role title</label>
          <SearchableTitleSelect
            roleType={roleType}
            exactJobTitle={exactJobTitle}
            onChange={({ role_type, exact_job_title }) => {
              setRoleType(role_type)
              setExactJobTitle(exact_job_title)
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
        <h3 className="text-sm font-semibold text-slate-900">Links</h3>
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

      {/* Specific connections to meet */}
      <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-6">
        <h3 className="text-sm font-semibold text-slate-900 mb-1">Who do you want to meet?</h3>
        <p className="text-xs text-slate-400 mb-3">Pick categories or specific titles. Tap a category to choose &ldquo;Anyone&rdquo; or specific titles.</p>
        <ConnectionTargetPicker value={desiredConnections} onChange={setDesiredConnections} />
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
      </div>

      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 px-4 py-3 rounded-lg">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={loading}
          className="flex items-center gap-2 bg-[#1B2850] text-white text-sm font-semibold px-6 py-2.5 rounded-lg hover:bg-[#2E4080] transition-colors disabled:opacity-60"
        >
          {loading && <Loader2 className="w-4 h-4 animate-spin" />}
          Save profile
        </button>
        {saved && (
          <span className="flex items-center gap-1.5 text-sm text-[#C4922A] font-medium">
            <CheckCircle className="w-4 h-4" />
            Saved!
          </span>
        )}
      </div>
    </form>
  )
}
