'use client'

import { useState } from 'react'
import { Loader2, CheckCircle } from 'lucide-react'
import { isValidFullName, FULL_NAME_ERROR } from '@/lib/validation/fullName'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

const ERROR_COPY: Record<string, string> = {
  MISSING_FIELDS:               'Please fill in the name and email address.',
  INVALID_EMAIL:                'Please enter a valid email address.',
  INVALID_LINKEDIN:             'Please enter a valid LinkedIn URL (including https://).',
  SELF_REFERRAL:                'You cannot nominate yourself.',
  NOTE_TOO_LONG:                'Your note is too long (max 2,000 characters).',
  EMAIL_ALREADY_MEMBER:         'This person is already a member.',
  EMAIL_ON_WAITLIST:            'This person is already being considered.',
  REFERRAL_PREVIOUSLY_REJECTED: 'This person was previously reviewed and is not eligible for re-nomination.',
  UNAUTHORIZED:                 'Your session has expired. Please refresh and try again.',
  REFERRER_INACTIVE:            'Your account is not currently active.',
  INVALID_FULL_NAME:            'Please enter their first and last name.',
  // Distinct from a missing profile on purpose: one is a fact about the member, the other is a
  // failure on our side. Telling someone their profile does not exist when the database simply did
  // not answer is what made the original bug so confusing.
  PROFILE_UNAVAILABLE:          'We could not verify your account just now. Please try again in a moment.',
  PROFILE_NOT_FOUND:            'We could not find your member profile. Please contact support.',
  WAITLIST_INSERT_FAILED:       'We could not save this nomination. Please try again.',
  REFERRAL_INSERT_FAILED:       'We could not save this nomination. Please try again.',
  INVALID_BODY:                 'Something went wrong sending your nomination. Please try again.',
  UNEXPECTED:                   'Something went wrong. Please try again.',
  NETWORK:                      'We could not reach the server. Check your connection and try again.',
}

export default function ReferralForm({ userEmail }: { userEmail: string }) {
  const [fullName, setFullName]         = useState('')
  const [email, setEmail]               = useState('')
  const [title, setTitle]               = useState('')
  const [company, setCompany]           = useState('')
  const [linkedinUrl, setLinkedinUrl]   = useState('')
  const [relationship, setRelationship] = useState('')
  const [referralNote, setReferralNote] = useState('')
  const [consent, setConsent]           = useState(false) // default unchecked = no consent
  const [state, setState]               = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [errorMsg, setErrorMsg]         = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    // The submit button is disabled while loading, but Enter in a text field still submits the
    // form, so re-entrancy is guarded here too. One submission per attempt.
    if (state === 'loading') return
    setErrorMsg('')

    // Client-side pre-validation — mirrors server checks exactly. The note ("why") is OPTIONAL
    // as of migration 092; only a name and an email address are required.
    if (!fullName.trim() || !email.trim()) {
      setErrorMsg(ERROR_COPY.MISSING_FIELDS)
      setState('error')
      return
    }
    // Nominee must have a real first + last name (mirrors the server).
    if (!isValidFullName(fullName)) {
      setErrorMsg(FULL_NAME_ERROR)
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
    if (linkedinUrl.trim() && !isValidHttpUrl(linkedinUrl.trim())) {
      setErrorMsg(ERROR_COPY.INVALID_LINKEDIN)
      setState('error')
      return
    }

    setState('loading')

    // GUARDED END TO END. Previously an unguarded `fetch` + `await res.json()` sat in an async
    // handler with no catch: when the route returned a non-JSON body (an opaque HTML 500 from an
    // unhandled server throw), res.json() threw, handleSubmit rejected, and NOTHING ran — the
    // button stayed spinning with no message. Every failure now lands in a visible error state.
    let res: Response
    try {
      res = await fetch('/api/referrals/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name:     fullName.trim(),
          email:         trimmedEmail,
          title:         title.trim() || undefined,
          company:       company.trim() || undefined,
          linkedin_url:  linkedinUrl.trim() || undefined,
          relationship:  relationship.trim() || undefined,
          referral_note: referralNote.trim() || null,
          consent,
        }),
      })
    } catch {
      setErrorMsg(ERROR_COPY.NETWORK)
      setState('error')
      return
    }

    // A body that is not JSON must not throw. `{}` falls through to the status-based copy below.
    let data: any = {}
    try { data = await res.json() } catch { data = {} }

    if (!res.ok) {
      setErrorMsg(ERROR_COPY[data.code] ?? data.error ?? ERROR_COPY.UNEXPECTED)
      setState('error')
      return
    }

    setFullName('')
    setEmail('')
    setTitle('')
    setCompany('')
    setLinkedinUrl('')
    setRelationship('')
    setReferralNote('')
    setConsent(false)
    setState('done')
  }

  if (state === 'done') {
    return (
      <div className="flex items-center gap-3 text-sm text-green-700 bg-green-50 border border-green-100 rounded-xl px-4 py-3">
        <CheckCircle className="w-4 h-4 flex-shrink-0" />
        Nomination submitted. We'll review it shortly.
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
          LinkedIn profile <span className="text-slate-400 font-normal">(optional)</span>
        </label>
        <input
          type="url"
          value={linkedinUrl}
          onChange={e => setLinkedinUrl(e.target.value)}
          placeholder="https://www.linkedin.com/in/…"
          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850] placeholder:text-slate-300"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-700 mb-1">
          Your relationship to them <span className="text-slate-400 font-normal">(optional)</span>
        </label>
        <input
          type="text"
          value={relationship}
          onChange={e => setRelationship(e.target.value)}
          placeholder="e.g. former colleague, client, longtime friend"
          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850] placeholder:text-slate-300"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-700 mb-1">
          Why would they strengthen the community? <span className="text-slate-400 font-normal">(optional)</span>
        </label>
        <textarea
          value={referralNote}
          onChange={e => { setReferralNote(e.target.value); if (state === 'error') setState('idle') }}
          placeholder="Tell us how you know them and why you'd personally vouch for them."
          rows={4}
          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850] placeholder:text-slate-300 resize-none"
        />
        <p className="text-xs text-slate-400 mt-1">Visible only to the Andrel team. Do not share this text with nominees.</p>
        <p className={`text-xs mt-1 text-right ${noteLength > 2000 ? 'text-red-500' : noteLength > 1800 ? 'text-amber-500' : 'text-slate-400'}`}>
          {noteLength} / 2,000
        </p>
      </div>

      <div className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-3">
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={consent}
            onChange={e => setConsent(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-[#1B2850] focus:ring-[#1B2850]/30"
          />
          <span className="text-xs text-slate-700 leading-relaxed">
            You may mention my name when inviting this person. If left unchecked, we&apos;ll keep your recommendation private.
          </span>
        </label>
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
        {state === 'loading' ? 'Submitting…' : 'Submit nomination'}
      </button>
    </form>
  )
}
