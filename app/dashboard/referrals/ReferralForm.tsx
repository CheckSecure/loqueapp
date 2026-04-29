'use client'

import { useState } from 'react'
import { Loader2, CheckCircle } from 'lucide-react'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const ERROR_COPY: Record<string, string> = {
  MISSING_FIELDS:               'Please fill in name, email, and your referral note.',
  INVALID_EMAIL:                'Please enter a valid email address.',
  SELF_REFERRAL:                'You cannot refer yourself.',
  NOTE_TOO_LONG:                'Your referral note is too long (max 2,000 characters).',
  EMAIL_ALREADY_MEMBER:         'This person is already a member.',
  EMAIL_ON_WAITLIST:            'This email is already on the waitlist.',
  REFERRAL_PREVIOUSLY_REJECTED: 'This referral was previously reviewed and is not eligible for re-referral.',
  CAP_REACHED:                  'You have reached the maximum of 3 outstanding referrals.',
  UNAUTHORIZED:                 'Your session has expired. Please refresh and try again.',
  REFERRER_INACTIVE:            'Your account is not currently active.',
}

export default function ReferralForm({ userEmail }: { userEmail: string }) {
  const [fullName, setFullName]         = useState('')
  const [email, setEmail]               = useState('')
  const [title, setTitle]               = useState('')
  const [company, setCompany]           = useState('')
  const [referralNote, setReferralNote] = useState('')
  const [state, setState]               = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [errorMsg, setErrorMsg]         = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErrorMsg('')

    // Client-side pre-validation — mirrors server checks exactly
    if (!fullName.trim() || !email.trim() || !referralNote.trim()) {
      setErrorMsg(ERROR_COPY.MISSING_FIELDS)
      setState('error')
      return
    }
    const trimmedEmail = email.trim()
    if (!EMAIL_REGEX.test(trimmedEmail)) {
      setErrorMsg(ERROR_COPY.INVALID_EMAIL)
      setState('error')
      return
    }
    if (trimmedEmail.toLowerCase() === userEmail.toLowerCase()) {
      setErrorMsg(ERROR_COPY.SELF_REFERRAL)
      setState('error')
      return
    }
    if (referralNote.trim().length > 2000) {
      setErrorMsg(ERROR_COPY.NOTE_TOO_LONG)
      setState('error')
      return
    }

    setState('loading')

    const res = await fetch('/api/referrals/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name:     fullName.trim(),
        email:         trimmedEmail,
        title:         title.trim() || undefined,
        company:       company.trim() || undefined,
        referral_note: referralNote.trim(),
      }),
    })

    const data = await res.json()

    if (!res.ok) {
      setErrorMsg(ERROR_COPY[data.code] ?? data.error ?? 'Something went wrong. Please try again.')
      setState('error')
      return
    }

    setFullName('')
    setEmail('')
    setTitle('')
    setCompany('')
    setReferralNote('')
    setState('done')
  }

  if (state === 'done') {
    return (
      <div className="flex items-center gap-3 text-sm text-green-700 bg-green-50 border border-green-100 rounded-xl px-4 py-3">
        <CheckCircle className="w-4 h-4 flex-shrink-0" />
        Referral submitted. We'll review it shortly.
      </div>
    )
  }

  const noteLength = referralNote.trim().length

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">
            Full name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={fullName}
            onChange={e => { setFullName(e.target.value); if (state === 'error') setState('idle') }}
            placeholder="Jane Smith"
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850] placeholder:text-slate-300"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">
            Email <span className="text-red-500">*</span>
          </label>
          <input
            type="email"
            value={email}
            onChange={e => { setEmail(e.target.value); if (state === 'error') setState('idle') }}
            placeholder="jane@example.com"
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850] placeholder:text-slate-300"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">
            Title <span className="text-slate-400 font-normal">(optional)</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="VP of Product"
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850] placeholder:text-slate-300"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">
            Company <span className="text-slate-400 font-normal">(optional)</span>
          </label>
          <input
            type="text"
            value={company}
            onChange={e => setCompany(e.target.value)}
            placeholder="Acme Corp"
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850] placeholder:text-slate-300"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-700 mb-1">
          Why are you referring this person? <span className="text-red-500">*</span>
        </label>
        <textarea
          value={referralNote}
          onChange={e => { setReferralNote(e.target.value); if (state === 'error') setState('idle') }}
          placeholder="Tell us how you know them and why they'd be a great fit for Andrel."
          rows={4}
          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850] placeholder:text-slate-300 resize-none"
        />
        <p className={`text-xs mt-1 text-right ${noteLength > 2000 ? 'text-red-500' : noteLength > 1800 ? 'text-amber-500' : 'text-slate-400'}`}>
          {noteLength} / 2,000
        </p>
      </div>

      {state === 'error' && errorMsg && (
        <p className="text-xs text-red-500">{errorMsg}</p>
      )}

      <button
        type="submit"
        disabled={state === 'loading'}
        className="flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-[#1B2850] rounded-lg hover:bg-[#2E4080] transition-colors disabled:opacity-60"
      >
        {state === 'loading' && <Loader2 className="w-4 h-4 animate-spin" />}
        {state === 'loading' ? 'Submitting…' : 'Submit referral'}
      </button>
    </form>
  )
}
