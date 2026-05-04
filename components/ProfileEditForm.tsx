'use client'

import { useState } from 'react'
import { parseExpertise } from '@/lib/parseExpertise'
import { EXPERTISE_OPTIONS } from '@/lib/profile-options'
import { Loader2, CheckCircle, User, ChevronDown, ChevronUp } from 'lucide-react'

const SENIORITY_OPTIONS = ['Junior', 'Mid-Level', 'Senior', 'Executive', 'C-Suite']

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
  const [currentStatus, setCurrentStatus] = useState(initialData.current_status || '')
  const [previousRoles, setPreviousRoles] = useState<{ company: string; title: string; start_date: string; end_date: string }[]>(
    Array.isArray(initialData.previous_roles) ? initialData.previous_roles : []
  )
  const initialExpertiseAll = parseExpertise(initialData.expertise)
  const [expertise, setExpertise] = useState<string[]>(initialExpertiseAll.filter(e => EXPERTISE_OPTIONS.includes(e)))
  const [additionalExpertise, setAdditionalExpertise] = useState<string[]>(initialExpertiseAll.filter(e => !EXPERTISE_OPTIONS.includes(e)))
  const [purposes, setPurposes] = useState<string[]>(Array.isArray(initialData.purposes) ? initialData.purposes : [])
  const [meetingFormat, setMeetingFormat] = useState(initialData.meeting_format_preference || 'both')
  const [geoScope, setGeoScope] = useState(initialData.geographic_scope || 'us-wide')
  const [openToBusinessSolutions, setOpenToBusinessSolutions] = useState(initialData.open_to_business_solutions || false)
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
    formData.append('current_status', currentStatus)
    formData.append('previous_roles', JSON.stringify(previousRoles))
    formData.append('expertise', [...expertise, ...additionalExpertise].join(','))
    formData.append('purposes', purposes.join(','))
    formData.append('meeting_format_preference', meetingFormat)
    formData.append('geographic_scope', geoScope)
    formData.append('open_to_business_solutions', openToBusinessSolutions.toString())
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
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">Employment Status <span className="text-slate-400 font-normal">(optional)</span></label>
            <select
              value={currentStatus}
              onChange={e => setCurrentStatus(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850]"
            >
              <option value="">Select status</option>
              <option value="employed">Currently employed</option>
              <option value="between_roles">Between roles</option>
              <option value="consulting_advisory">Consulting / advisory</option>
              <option value="prefer_not_to_say">Prefer not to say</option>
            </select>
          </div>

          {['between_roles', 'consulting_advisory'].includes(currentStatus) && (
            <div className="col-span-2 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
              <p className="text-xs text-slate-500">Make sure your title, company, and bio are up to date so members have accurate context before connecting.</p>
            </div>
          )}

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

          {additionalExpertise.length > 0 && (
            <div className="col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Additional expertise <span className="text-slate-400 font-normal">(legacy values you've previously saved)</span></label>
              <div className="flex flex-wrap gap-2">
                {additionalExpertise.map(item => (
                  <span key={item} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border bg-slate-50 text-slate-600 border-slate-200">
                    {item}
                    <button
                      type="button"
                      onClick={() => setAdditionalExpertise(prev => prev.filter(x => x !== item))}
                      className="text-slate-400 hover:text-slate-700 transition-colors"
                      aria-label={`Remove ${item}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

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
            <label className="flex items-start gap-3 cursor-pointer group">
              <div className="relative">
                <input
                  type="checkbox"
                  checked={openToBusinessSolutions}
                  onChange={e => setOpenToBusinessSolutions(e.target.checked)}
                  className="peer sr-only"
                />
                <div className="w-11 h-6 bg-slate-200 rounded-full peer-checked:bg-[#1B2850] transition-colors"></div>
                <div className="absolute left-1 top-1 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-5"></div>
              </div>
              <div className="flex-1">
                <span className="text-xs font-semibold text-slate-700">Open to business solutions</span>
                <p className="text-xs text-slate-500 mt-0.5">Occasionally see relevant solution providers and service partners</p>
              </div>
            </label>
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

          <div className="col-span-2">
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">Previous Roles <span className="text-slate-400 font-normal">(optional)</span></label>
            <div className="space-y-3">
              {previousRoles.map((role, i) => (
                <div key={i} className="border border-slate-200 rounded-lg p-3 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Company *</label>
                      <input
                        type="text"
                        value={role.company}
                        onChange={e => { const u = [...previousRoles]; u[i] = { ...u[i], company: e.target.value }; setPreviousRoles(u) }}
                        placeholder="Acme Corp"
                        className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Title *</label>
                      <input
                        type="text"
                        value={role.title}
                        onChange={e => { const u = [...previousRoles]; u[i] = { ...u[i], title: e.target.value }; setPreviousRoles(u) }}
                        placeholder="General Counsel"
                        className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Start date</label>
                      <input
                        type="text"
                        value={role.start_date}
                        onChange={e => { const u = [...previousRoles]; u[i] = { ...u[i], start_date: e.target.value }; setPreviousRoles(u) }}
                        placeholder="Jan 2019"
                        className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">End date</label>
                      <input
                        type="text"
                        value={role.end_date}
                        onChange={e => { const u = [...previousRoles]; u[i] = { ...u[i], end_date: e.target.value }; setPreviousRoles(u) }}
                        placeholder="Mar 2023"
                        className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850]"
                      />
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPreviousRoles(prev => prev.filter((_, idx) => idx !== i))}
                    className="text-xs text-red-500 hover:text-red-700 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              ))}
              {previousRoles.length < 5 && (
                <button
                  type="button"
                  onClick={() => setPreviousRoles(prev => [...prev, { company: '', title: '', start_date: '', end_date: '' }])}
                  className="text-xs font-medium text-[#1B2850] hover:text-[#2E4080] transition-colors"
                >
                  + Add role
                </button>
              )}
            </div>
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
