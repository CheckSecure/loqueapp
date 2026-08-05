'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Sparkles, Briefcase, MapPin, CheckCircle, Loader2, Heart, AlertCircle } from 'lucide-react'
import { EnlargeableAvatar } from '@/components/EnlargeableAvatar'
import { toList } from '@/lib/match-signals'
import { professionalIdentity } from '@/lib/professionalIdentity'
import MatchIntelligenceCard from '@/components/MatchIntelligenceCard'
import type { MatchSignal } from '@/lib/matchIntelligence'

interface IncomingInterestCardProps {
  introRequestId: string
  requester: {
    id: string
    full_name: string | null
    title: string | null
    exact_job_title: string | null
    company: string | null
    location: string | null
    avatar_url: string | null
    bio: string | null
    seniority: string | null
    role_type: string | null
    expertise?: unknown
  }
  /** Curated reason this pairing may be a good connection (stored match_reason). */
  matchReason?: string | null
  /** Structured Match Intelligence signals (built server-side). Display only. */
  signals?: MatchSignal[]
  /** Conversation starters derived from the signals (display only). */
  starters?: string[]
}

function initials(name: string | null) {
  return (name || '?').split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase()
}

const AVATAR_COLORS = ['bg-[#1B2850]', 'bg-[#2E4080]', 'bg-amber-500', 'bg-rose-500', 'bg-cyan-600', 'bg-teal-600', 'bg-pink-500', 'bg-slate-600']
function pickColor(id: string) {
  const n = (id || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return AVATAR_COLORS[n % AVATAR_COLORS.length]
}

export default function IncomingInterestCard({ introRequestId, requester, matchReason, signals, starters }: IncomingInterestCardProps) {
  const router = useRouter()
  const expertiseTags = toList(requester.expertise)
  const identity = professionalIdentity(requester)
  const firstName = requester.full_name?.split(' ')[0] || 'They'
  // idle → review (read-only confirm, no mutation) → confirming → matched/error/no_credits
  //      → declining → declined
  const [state, setState] = useState<'idle' | 'review' | 'confirming' | 'matched' | 'declining' | 'declined' | 'no_credits' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  async function handleConfirm() {
    setState('confirming'); setErrorMsg('')
    try {
      const res = await fetch('/api/intro-requests/accept-incoming', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ introRequestId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (String(data.error || '').toLowerCase().includes('credit')) { setState('no_credits'); return }
        setErrorMsg(data.error || data.message || 'Could not connect'); setState('error'); return
      }
      setState('matched')
      setTimeout(() => { router.push('/dashboard/network') }, 1200)
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unexpected error'); setState('error')
    }
  }

  async function handleDecline() {
    setState('declining'); setErrorMsg('')
    try {
      const res = await fetch('/api/intro-requests/decline-incoming', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ introRequestId }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setErrorMsg(data.error || 'Failed to decline'); setState('error'); return
      }
      setState('declined')
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unexpected error'); setState('error')
    }
  }

  const avatarColor = pickColor(requester.id)

  return (
    <div className="bg-white border border-brand-gold/30 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col gap-3">
      <p className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-brand-gold">
        <Heart className="w-3 h-3" /> Interested in you
      </p>

      <div className="flex items-start gap-3">
        <EnlargeableAvatar src={requester.avatar_url} name={requester.full_name} className="flex-shrink-0">
          {requester.avatar_url ? (
            <img src={requester.avatar_url} alt={requester.full_name || ''} className="w-11 h-11 rounded-full object-cover" />
          ) : (
            <div className={'w-11 h-11 rounded-full flex items-center justify-center text-white font-bold text-sm ' + avatarColor}>{initials(requester.full_name)}</div>
          )}
        </EnlargeableAvatar>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-900 truncate">{requester.full_name || 'A member'}</p>
          {identity.primary && (
            <div className="mt-0.5">
              <div className="flex items-center gap-1 text-xs text-slate-500">
                <Briefcase className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{identity.primary}</span>
              </div>
              {identity.secondary && <p className="ml-4 text-[11px] text-slate-400 truncate">{identity.secondary}</p>}
            </div>
          )}
          {requester.location && (
            <div className="flex items-center gap-1 text-xs text-slate-400 mt-0.5">
              <MapPin className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{requester.location}</span>
            </div>
          )}
        </div>
      </div>

      {requester.bio && <p className="text-xs text-slate-500 leading-relaxed line-clamp-2">{requester.bio}</p>}

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

      {/* Match Intelligence: structured signals when available, else the stored
          match_reason (newline-bullet contract preserved), else generic. Signals
          are neutral commonalities — they never imply mutual interest. */}
      <MatchIntelligenceCard signals={signals ?? []} starters={starters} fallbackReason={matchReason} title="Why you may connect" />

      {/* IDLE — Accept opens the review step; nothing is mutated yet. */}
      {state === 'idle' && (
        <div className="flex gap-2 pt-1">
          <button
            onClick={() => setState('review')}
            className="flex-1 min-h-[44px] text-sm font-semibold bg-[#1B2850] text-white py-2.5 rounded-lg hover:bg-[#2E4080] transition-colors"
          >
            Accept
          </button>
          <button
            onClick={handleDecline}
            className="px-4 min-h-[44px] text-sm text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
          >
            Decline
          </button>
        </div>
      )}

      {/* REVIEW — read-only confirmation. Only "Connect and use 1 credit" mutates. */}
      {state === 'review' && (
        <div className="rounded-lg border border-brand-navy/15 bg-[#F5F6FB] px-3.5 py-3 space-y-2.5">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-brand-navy/70 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-slate-600 leading-relaxed">
              Confirming creates the mutual introduction to <span className="font-semibold text-brand-navy">{requester.full_name || firstName}</span> and opens a conversation. <span className="font-semibold text-brand-navy">1 credit will be used.</span>
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleConfirm}
              className="flex-1 min-h-[44px] text-sm font-semibold bg-[#1B2850] text-white py-2.5 rounded-lg hover:bg-[#2E4080] transition-colors"
            >
              Connect and use 1 credit
            </button>
            <button
              onClick={() => setState('idle')}
              className="px-4 min-h-[44px] text-sm text-slate-600 border border-slate-300 rounded-lg hover:bg-white transition-colors"
            >
              Not now
            </button>
          </div>
        </div>
      )}

      {(state === 'confirming' || state === 'declining') && (
        <div className="flex items-center justify-center gap-2 text-sm font-medium text-slate-600 bg-slate-50 border border-slate-100 py-2.5 rounded-lg">
          <Loader2 className="w-4 h-4 animate-spin" />
          {state === 'confirming' ? 'Connecting' : 'Declining'}
        </div>
      )}

      {state === 'matched' && (
        <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-2.5 rounded-lg">
          <Sparkles className="w-4 h-4" /> Connected — opening your conversation
        </div>
      )}

      {state === 'declined' && <div className="text-sm text-slate-500 text-center py-2">Declined</div>}

      {state === 'no_credits' && (
        <div className="space-y-2">
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">You need 1 credit to connect. No credit was used.</p>
          <a href="/dashboard/billing" className="block text-center text-xs font-semibold text-white bg-[#1B2850] py-2 rounded-lg hover:bg-[#162040]">Get credits</a>
        </div>
      )}

      {state === 'error' && errorMsg && <p className="text-xs text-red-600 text-center">{errorMsg}</p>}

      <Link
        href={`/dashboard/profile/${requester.id}`}
        className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition-colors hover:text-brand-navy"
      >
        View full profile <span aria-hidden="true">→</span>
      </Link>
    </div>
  )
}
