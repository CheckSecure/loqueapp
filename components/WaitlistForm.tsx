'use client'

import { useState } from 'react'
import { Loader2, CheckCircle, Lock, Linkedin } from 'lucide-react'
import { cn } from '@/lib/utils'
import { submitWaitlist } from '@/app/actions'

const ROLE_OPTIONS = [
  { value: '', label: 'Select your role type' },
  { value: 'in_house_counsel', label: 'In-house Counsel' },
  { value: 'law_firm_attorney', label: 'Law Firm Attorney' },
  { value: 'legal_operations', label: 'Legal Operations' },
  { value: 'compliance_risk', label: 'Compliance / Risk' },
  { value: 'privacy_data', label: 'Privacy / Data Protection' },
  { value: 'regulatory_affairs', label: 'Regulatory Affairs' },
  { value: 'government_affairs', label: 'Government Affairs' },
  { value: 'strategy_consulting', label: 'Strategy / Consulting' },
  { value: 'legal_tech_startup', label: 'Legal Tech / Startup' },
  { value: 'executive_csuite', label: 'Executive / C-Suite' },
  { value: 'investor_vc', label: 'Investor / VC' },
  { value: 'government_policy', label: 'Government / Policy' },
  { value: 'finance_professional', label: 'Finance Professional' },
  { value: 'healthcare_professional', label: 'Healthcare Professional' },
  { value: 'other', label: 'Other' },
]

export default function WaitlistForm() {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [title, setTitle] = useState('')
  const [company, setCompany] = useState('')
  const [roleType, setRoleType] = useState('')
  const [linkedinUrl, setLinkedinUrl] = useState('')
  const [meetingInterests, setMeetingInterests] = useState('')
  const [referral, setReferral] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const result = await submitWaitlist({ 
      fullName, 
      email, 
      title,
      company, 
      roleType, 
      linkedinUrl,
      meetingInterests,
      referral 
    })
    setLoading(false)
    if (result.error) {
      setError(result.error)
      return
    }
    setDone(true)
  }

  if (done) {
    return (
      <div className="bg-white/10 backdrop-blur border border-white/20 rounded-2xl p-8 text-center">
        <div className="w-12 h-12 bg-[#C4922A]/20 rounded-full flex items-center justify-center mx-auto mb-4">
          <CheckCircle className="w-6 h-6 text-[#C4922A]" />
        </div>
        <h3 className="text-lg font-bold text-white mb-2">You're on the list.</h3>
        <p className="text-white/70 text-sm leading-relaxed">
          We'll be in touch when your spot is ready.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white/10 backdrop-blur border border-white/20 rounded-2xl p-6 space-y-3.5">
      <div className="flex items-center gap-2 mb-1">
        <Lock className="w-3.5 h-3.5 text-[#C4922A]" />
        <span className="text-xs font-semibold text-[#C4922A] uppercase tracking-wide">Request Access</span>
      </div>

      {error && (
        <div className="bg-red-500/20 border border-red-400/30 text-red-200 text-xs px-3 py-2.5 rounded-lg">
          {error}
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-white/70 mb-1.5">Full name <span className="text-[#C4922A]">*</span></label>
          <input
            type="text"
            required
            value={fullName}
            onChange={e => setFullName(e.target.value)}
            placeholder="Jane Smith"
            className="w-full px-3.5 py-2.5 bg-white/10 border border-white/20 rounded-lg text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[#C4922A] focus:border-transparent transition"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-white/70 mb-1.5">Work email <span className="text-[#C4922A]">*</span></label>
          <input
            type="email"
            required
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@company.com"
            className="w-full px-3.5 py-2.5 bg-white/10 border border-white/20 rounded-lg text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[#C4922A] focus:border-transparent transition"
          />
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-white/70 mb-1.5">Title <span className="text-[#C4922A]">*</span></label>
          <input
            type="text"
            required
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="General Counsel"
            className="w-full px-3.5 py-2.5 bg-white/10 border border-white/20 rounded-lg text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[#C4922A] focus:border-transparent transition"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-white/70 mb-1.5">Company <span className="text-[#C4922A]">*</span></label>
          <input
            type="text"
            required
            value={company}
            onChange={e => setCompany(e.target.value)}
            placeholder="Acme Corp"
            className="w-full px-3.5 py-2.5 bg-white/10 border border-white/20 rounded-lg text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[#C4922A] focus:border-transparent transition"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-white/70 mb-1.5">Role type <span className="text-[#C4922A]">*</span></label>
        <select
          required
          value={roleType}
          onChange={e => setRoleType(e.target.value)}
          className="w-full px-3.5 py-2.5 bg-white/10 border border-white/20 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#C4922A] focus:border-transparent transition appearance-none"
          style={{ colorScheme: 'dark' }}
        >
          {ROLE_OPTIONS.map(o => (
            <option key={o.value} value={o.value} className="bg-[#1B2850] text-white">
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-medium text-white/70 mb-1.5 flex items-center gap-1.5">
          <Linkedin className="w-3 h-3" />
          LinkedIn profile <span className="text-white/30">(optional)</span>
        </label>
        <input
          type="url"
          value={linkedinUrl}
          onChange={e => setLinkedinUrl(e.target.value)}
          placeholder="https://linkedin.com/in/yourprofile"
          className="w-full px-3.5 py-2.5 bg-white/10 border border-white/20 rounded-lg text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[#C4922A] focus:border-transparent transition"
        />
        <p className="text-[10px] text-white/50 mt-1.5">Helps us prioritize your application</p>
      </div>

      <div>
        <label className="block text-xs font-medium text-white/70 mb-1.5">Who would you like to meet? <span className="text-white/30">(optional)</span></label>
        <input
          type="text"
          value={meetingInterests}
          onChange={e => setMeetingInterests(e.target.value)}
          placeholder="Investors, legal tech founders, GCs in healthcare..."
          className="w-full px-3.5 py-2.5 bg-white/10 border border-white/20 rounded-lg text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[#C4922A] focus:border-transparent transition"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-white/70 mb-1.5">How did you hear about Andrel? <span className="text-white/30">(optional)</span></label>
        <input
          type="text"
          value={referral}
          onChange={e => setReferral(e.target.value)}
          placeholder="LinkedIn, a colleague, an event..."
          className="w-full px-3.5 py-2.5 bg-white/10 border border-white/20 rounded-lg text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[#C4922A] focus:border-transparent transition"
        />
      </div>

      <button
        type="submit"
        disabled={loading}
        className={cn(
          'w-full flex items-center justify-center gap-2 bg-[#C4922A] text-white text-sm font-bold px-5 py-3 rounded-xl hover:bg-[#b07d24] transition-colors mt-1',
          loading && 'opacity-70 cursor-not-allowed'
        )}
      >
        {loading && <Loader2 className="w-4 h-4 animate-spin" />}
        Request access
      </button>

      <p className="text-[11px] text-white/40 text-center">
        We personally review every application to maintain the quality of our network.
      </p>
    </form>
  )
}
