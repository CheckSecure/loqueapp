'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Sparkles, Briefcase, MapPin, CheckCircle, Loader2, X } from 'lucide-react'
import { EnlargeableAvatar } from '@/components/EnlargeableAvatar'
import { toList } from '@/lib/match-signals'
import { professionalIdentity } from '@/lib/professionalIdentity'

interface AdminIntroCardProps {
  introRequestId: string
  otherUser: {
    id: string
    full_name: string | null
    title: string | null
    company: string | null
    location: string | null
    avatar_url: string | null
    bio: string | null
    seniority: string | null
    role_type: string | null
    expertise?: unknown
  }
  otherAlreadyApproved?: boolean
  userAlreadyAccepted?: boolean
  /** Curated reason for this introduction. Rendered prominently when present; generic fallback otherwise. */
  matchReason?: string | null
  /** Common-ground signals (computeMatchSignals output), computed server-side. Display only. */
  commonGround?: string[]
}

function initials(name: string | null) {
  return (name || '?').split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase()
}

const AVATAR_COLORS = ['bg-[#1B2850]','bg-[#2E4080]','bg-amber-500','bg-rose-500','bg-cyan-600','bg-teal-600','bg-pink-500','bg-slate-600']
function pickColor(id: string) {
  const n = (id || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return AVATAR_COLORS[n % AVATAR_COLORS.length]
}

export default function AdminIntroCard({ introRequestId, otherUser, otherAlreadyApproved, userAlreadyAccepted, matchReason, commonGround }: AdminIntroCardProps) {
  const expertiseTags = toList(otherUser.expertise)
  const router = useRouter()
  const [state, setState] = useState<'idle' | 'accepting' | 'passing' | 'accepted' | 'matched' | 'passed' | 'no_credits' | 'error'>(userAlreadyAccepted ? 'accepted' : 'idle')
  const [errorMsg, setErrorMsg] = useState('')

  async function handleAccept() {
    setState('accepting'); setErrorMsg('')
    try {
      const res = await fetch('/api/intro-requests/express-interest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ introRequestId })
      })
      const data = await res.json()
      if (!res.ok) {
        if (String(data.error || '').toLowerCase().includes('credit')) { setState('no_credits'); return }
        setErrorMsg(data.error || data.message || 'Failed to accept'); setState('error'); return
      }
      if (data.matchCreated) {
        setState('matched')
        setTimeout(() => { router.push('/dashboard/network') }, 1200)
      } else {
        setState('accepted')
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unexpected error'); setState('error')
    }
  }

  async function handlePass() {
    setState('passing'); setErrorMsg('')
    try {
      const res = await fetch('/api/intro-requests/decline-admin-intro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ introRequestId })
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setErrorMsg(data.error || 'Failed to pass'); setState('error'); return
      }
      setState('passed')
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unexpected error'); setState('error')
    }
  }

  const avatarColor = pickColor(otherUser.id)

  return (
    <div className="bg-white border border-[#C4922A]/20 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col gap-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-brand-gold">Introduced by Andrel</p>
      <div className="flex items-start gap-3">
        <EnlargeableAvatar src={otherUser.avatar_url} name={otherUser.full_name} className="flex-shrink-0">
          {otherUser.avatar_url ? (
            <img src={otherUser.avatar_url} alt={otherUser.full_name || ''} className="w-11 h-11 rounded-full object-cover" />
          ) : (
            <div className={'w-11 h-11 rounded-full flex items-center justify-center text-white font-bold text-sm ' + avatarColor}>{initials(otherUser.full_name)}</div>
          )}
        </EnlargeableAvatar>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-900 truncate">{otherUser.full_name || 'New member'}</p>
          {(() => { const identity = professionalIdentity(otherUser); return identity.primary ? (
            <div className="mt-0.5">
              <div className="flex items-center gap-1 text-xs text-slate-500">
                <Briefcase className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{identity.primary}</span>
              </div>
              {identity.secondary && (
                <p className="ml-4 text-[11px] text-slate-400 truncate">{identity.secondary}</p>
              )}
            </div>
          ) : null })()}
          {otherUser.location && (
            <div className="flex items-center gap-1 text-xs text-slate-400 mt-0.5">
              <MapPin className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{otherUser.location}</span>
            </div>
          )}
        </div>
      </div>
      {otherUser.bio && <p className="text-xs text-slate-500 leading-relaxed line-clamp-2">{otherUser.bio}</p>}

      {expertiseTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {expertiseTags.slice(0, 5).map((tag) => (
            <span key={tag} className="rounded-full border border-brand-navy/10 bg-brand-navy/[0.04] px-2.5 py-0.5 text-[11px] font-medium text-brand-navy/80">{tag}</span>
          ))}
          {expertiseTags.length > 5 && (
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-medium text-slate-500">+{expertiseTags.length - 5} more</span>
          )}
        </div>
      )}

      <div className="rounded-lg bg-gradient-to-br from-brand-gold-soft via-brand-gold-soft/60 to-white border border-brand-gold/25 px-3.5 py-2.5">
        <div className="flex items-start gap-2.5">
          <Sparkles className="w-4 h-4 text-brand-gold flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] uppercase tracking-[0.14em] font-bold text-brand-gold mb-1">Why we introduced you</p>
            <p className="text-sm text-brand-navy leading-relaxed">
              {matchReason || 'Based on your background and professional interests, Andrel selected this introduction.'}
            </p>
          </div>
        </div>
      </div>

      {commonGround && commonGround.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {commonGround.slice(0, 4).map((sig) => (
            <span key={sig} className="inline-flex items-center rounded-full border border-brand-gold/20 bg-brand-gold-soft/50 px-2.5 py-0.5 text-[11px] font-medium text-brand-navy/75">{sig}</span>
          ))}
        </div>
      )}

      {otherAlreadyApproved && state === 'idle' && (
        <div className="text-xs font-medium text-[#1B2850] bg-[#F5F6FB] border border-[#1B2850]/10 rounded-lg px-3 py-2">
          {otherUser.full_name?.split(' ')[0] || 'They'} accepted — last step.
        </div>
      )}

      {state === 'accepted' && (
        <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-2.5 rounded-lg">
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          Waiting on {otherUser.full_name?.split(' ')[0] || 'them'}
        </div>
      )}

      {state === 'matched' && (
        <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-2.5 rounded-lg">
          <Sparkles className="w-4 h-4" />
          Connected
        </div>
      )}

      {state === 'passed' && (
        <div className="text-sm text-slate-500 text-center py-2">Passed</div>
      )}

      {state === 'no_credits' && (
        <div className="space-y-2">
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">You'll use 1 credit only if both members accept.</p>
          <a href="/dashboard/billing" className="block text-center text-xs font-semibold text-white bg-[#1B2850] py-2 rounded-lg hover:bg-[#162040]">Get credits</a>
        </div>
      )}

      {state === 'idle' && (
        <div className="flex gap-2 pt-1">
          <button
            onClick={handleAccept}
            disabled={false}
            className="flex-1 min-h-[44px] text-sm font-semibold bg-[#1B2850] text-white py-2.5 rounded-lg hover:bg-[#2E4080] transition-colors"
          >
            Accept Introduction
          </button>
          <button
            onClick={handlePass}
            disabled={false}
            className="px-4 min-h-[44px] text-sm text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
          >
            Pass
          </button>
        </div>
      )}

      {(state === 'accepting' || state === 'passing') && (
        <div className="flex items-center justify-center gap-2 text-sm font-medium text-slate-600 bg-slate-50 border border-slate-100 py-2.5 rounded-lg">
          <Loader2 className="w-4 h-4 animate-spin" />
          {state === 'accepting' ? 'Accepting' : 'Passing'}
        </div>
      )}

      {state === 'error' && errorMsg && (<p className="text-xs text-red-600 text-center">{errorMsg}</p>)}

      <Link
        href={`/dashboard/profile/${otherUser.id}`}
        className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition-colors hover:text-brand-navy"
      >
        View full profile
        <span aria-hidden="true">→</span>
      </Link>
    </div>
  )
}
