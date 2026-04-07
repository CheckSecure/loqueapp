'use client'

import { useState } from 'react'
import { Loader2, CheckCircle, User, ChevronDown, ChevronUp } from 'lucide-react'

const SENIORITY_OPTIONS = ['Junior', 'Mid-Level', 'Senior', 'Executive', 'C-Suite']
const EXPERTISE_OPTIONS = ['Strategy', 'Operations', 'Legal', 'Finance', 'Sales', 'Marketing', 'Product', 'Engineering', 'HR', 'Other']
const PURPOSE_OPTIONS = ['Fundraising', 'Hiring', 'Partnerships', 'Mentorship', 'Business Development', 'Market Insights', 'Career Growth']

export default function ProfileEditForm({ initialData }: { initialData: any }) {
  const [isOpen, setIsOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [fullName, setFullName] = useState(initialData.full_name || '')
  const [title, setTitle] = useState(initialData.title || '')
  const [company, setCompany] = useState(initialData.company || '')
  const [city, setCity] = useState(initialData.city || '')
  const [state, setState] = useState(initialData.state || '')
  const [seniority, setSeniority] = useState(initialData.seniority || '')
  const [expertise, setExpertise] = useState<string[]>(Array.isArray(initialData.expertise) ? initialData.expertise : [])
  const [purposes, setPurposes] = useState<string[]>(Array.isArray(initialData.purposes) ? initialData.purposes : [])
  const [meetingFormat, setMeetingFormat] = useState(initialData.meeting_format_preference || 'both')
  const [geoScope, setGeoScope] = useState(initialData.geographic_scope || 'us-wide')
  const [bio, setBio] = useState(initialData.bio || '')

  const toggleExpertise = (item: string) => {
    setExpertise(prev => prev.includes(item) ? prev.filter(x => x !== item) : [...prev, item])
  }

  const togglePurpose = (item: string) => {
    setPurposes(prev => prev.includes(item) ? prev.filter(x => x !== item) : [...prev, item])
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    setSaving(true)

    const formData = new FormData()
    formData.append('full_name', fullName)
    formData.append('title', title)
    formData.append('company', company)
    formData.append('city', city)
    formData.append('state', state)
    formData.append('seniority', seniority)
    formData.append('expertise', expertise.join(','))
    formData.append('purposes', purposes.join(','))
    formData.append('meeting_format_preference', meetingFormat)
    formData.append('geographic_scope', geoScope)
    formData.append('bio', bio)

    const res = await fetch('/api/profile/update', {
      method: 'POST',
      body: formData,
    })

    setSaving(false)

    if (!res.ok) {
      const data = await res.json()
      setError(data.error || 'Failed to update profile')
      return
    }

    setSuccess(true)
    setTimeout(() => {
      setSuccess(false)
      setIsOpen(false)
    }, 2000)
  }

  if (!isOpen) {
    return (
      <section className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <button
          onClick={() => setIsOpen(true)}
          className="w-full px-6 py-4 flex items-center justify-between hover:bg-slate-50 transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-[#F5F6FB] rounded-lg flex items-center justify-center">
              <User className="w-4 h-4 text-[#1B2850]" />
            </div>
            <div className="text-left">
              <h2 className="text-sm font-semibold text-slate-900">Edit Profile</h2>
              <p className="text-xs text-slate-400">Update your professional details and preferences</p>
            </div>
          </div>
          <ChevronDown className="w-5 h-5 text-slate-400" />
        </button>
      </section>
    )
  }

  return (
    <section className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <button
        onClick={() => setIsOpen(false)}
        className="w-full px-6 py-4 flex items-center justify-between border-b border-slate-100 hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-[#F5F6FB] rounded-lg flex items-center justify-center">
            <User className="w-4 h-4 text-[#1B2850]" />
          </div>
          <div className="text-left">
            <h2 className="text-sm font-semibold text-slate-900">Edit Profile</h2>
            <p className="text-xs text-slate-400">Update your professional details and preferences</p>
          </div>
        </div>
        <ChevronUp className="w-5 h-5 text-slate-400" />
      </button>

      <form onSubmit={handleSubmit} className="px-6 py-5 space-y-5">
        {success && (
          <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 px-4 py-3 rounded-lg">
            <CheckCircle className="w-4 h-4 flex-shrink-0" />
            Profile updated successfully.
          </div>
        )}
        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-100 px-4 py-3 rounded-lg">{error}</div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">Full Name</label>
            <input
              type="text"
              value={fullName}
              onChange={e => setFullName(e.target.value)}
              required
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">Title</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g., General Counsel"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">Company</label>
            <input
              type="text"
              value={company}
              onChange={e => setCompany(e.target.value)}
              placeholder="e.g., Acme Corp"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">City</label>
            <input
              type="text"
              value={city}
              onChange={e => setCity(e.target.value)}
              placeholder="e.g., New York"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">State</label>
            <input
              type="text"
              value={state}
              onChange={e => setState(e.target.value)}
              placeholder="e.g., NY"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850]"
            />
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">Seniority</label>
            <select
              value={seniority}
              onChange={e => setSeniority(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850]"
            >
              <option value="">Select seniority</option>
              {SENIORITY_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">Expertise (select all that apply)</label>
            <div className="flex flex-wrap gap-2">
              {EXPERTISE_OPTIONS.map(e => (
                <button
                  key={e}
                  type="button"
                  onClick={() => toggleExpertise(e)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                    expertise.includes(e)
                      ? 'bg-[#1B2850] text-white border-[#1B2850]'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-[#1B2850]/30'
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">Current Goals (select all that apply)</label>
            <div className="flex flex-wrap gap-2">
              {PURPOSE_OPTIONS.map(p => (
                <button
                  key={p}
                  type="button"
                  onClick={() => togglePurpose(p)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                    purposes.includes(p)
                      ? 'bg-[#1B2850] text-white border-[#1B2850]'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-[#1B2850]/30'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">Meeting Preference</label>
            <select
              value={meetingFormat}
              onChange={e => setMeetingFormat(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850]"
            >
              <option value="both">Both virtual and in-person</option>
              <option value="virtual">Virtual only</option>
              <option value="in-person">In-person only</option>
            </select>
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">Geographic Scope</label>
            <select
              value={geoScope}
              onChange={e => setGeoScope(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850]"
            >
              <option value="us-wide">Open to connections nationwide</option>
              <option value="local">Prefer local connections only</option>
            </select>
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">Bio (optional)</label>
            <textarea
              value={bio}
              onChange={e => setBio(e.target.value)}
              rows={3}
              placeholder="A brief professional bio..."
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850]"
            />
          </div>
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2 bg-[#1B2850] text-white text-sm font-semibold rounded-lg hover:bg-[#162040] transition-colors disabled:opacity-60"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="px-5 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </section>
  )
}
