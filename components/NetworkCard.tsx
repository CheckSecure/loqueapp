'use client'

import { useState } from 'react'
import { Briefcase, MapPin, MessageSquare, Calendar, Eye } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import ConnectionDetailModal from '@/components/network/ConnectionDetailModal'
import FormerMemberBadge from '@/components/FormerMemberBadge'
import { EnlargeableAvatar } from '@/components/EnlargeableAvatar'

const AVATAR_COLORS = [
  'bg-[#1B2850]','bg-[#2E4080]','bg-amber-500','bg-rose-500',
  'bg-cyan-600','bg-teal-600','bg-pink-500','bg-slate-600',
]
function pickColor(id: string) {
  const n = (id || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return AVATAR_COLORS[n % AVATAR_COLORS.length]
}
function getInitials(name?: string) {
  return (name || '?').split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase()
}

interface NetworkCardProps {
  matchId: string
  profile: any
  connectedAt: string | null
  isNew: boolean
  matchInsights?: { text: string; kind: string }[]
  conversationId?: string | null
}

export default function NetworkCard({ matchId, profile, connectedAt, isNew, matchInsights, conversationId }: NetworkCardProps) {
  const [highlighted, setHighlighted] = useState(isNew)
  const [modalOpen, setModalOpen] = useState(false)
  const [navigatingToMessage, setNavigatingToMessage] = useState(false)
  const router = useRouter()

  const isDeactivated = profile.account_status === 'deactivated'
  const avatarColor = pickColor(profile.id)
  const initials = getInitials(profile.full_name)
  const connectedRelative = (() => {
    if (!connectedAt) return null
    const d = new Date(connectedAt)
    if (Number.isNaN(d.getTime()) || d.getTime() === 0) return null
    return formatDistanceToNow(d, { addSuffix: true })
  })()

  function handleOpenDetails(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    setHighlighted(false)
    setModalOpen(true)
  }

  function handleCardClick(e: React.MouseEvent) {
    const target = e.target as HTMLElement
    if (target.closest('[data-card-action]')) return
    setHighlighted(false)
    setModalOpen(true)
  }

  async function handleMessageClick(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (navigatingToMessage) return
    if (conversationId) {
      router.push(`/dashboard/messages/${conversationId}`)
      return
    }
    setNavigatingToMessage(true)
    try {
      const res = await fetch('/api/conversations/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId })
      })
      if (!res.ok) {
        router.push('/dashboard/messages')
        return
      }
      const data = await res.json()
      if (data.conversationId) {
        router.push(`/dashboard/messages/${data.conversationId}`)
      } else {
        router.push('/dashboard/messages')
      }
    } catch {
      router.push('/dashboard/messages')
    } finally {
      setNavigatingToMessage(false)
    }
  }

  return (
    <>
      <div
        onClick={handleCardClick}
        className={`bg-white border rounded-xl p-5 shadow-sm hover:shadow-md transition-all cursor-pointer flex flex-col gap-4 ${
          highlighted ? 'border-brand-gold/40 bg-brand-cream/30' : 'border-slate-200/70'
        }`}
      >
        <div className="flex items-start gap-3">
          <EnlargeableAvatar src={profile.avatar_url} name={profile.full_name} className="flex-shrink-0">
            {profile.avatar_url ? (
              <img src={profile.avatar_url} alt={profile.full_name} className={`w-11 h-11 rounded-full object-cover ring-1 ring-slate-200 ${isDeactivated ? 'grayscale opacity-60' : ''}`} />
            ) : (
              <div className={`w-11 h-11 rounded-full ${avatarColor} flex items-center justify-center text-white text-sm font-bold`}>
                {initials}
              </div>
            )}
          </EnlargeableAvatar>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-brand-navy truncate">
                {isDeactivated ? 'Former member' : profile.full_name}
              </p>
              {highlighted && !isDeactivated && (
                <span className="px-1.5 py-0.5 bg-brand-gold-soft text-brand-gold border border-brand-gold/30 text-[10px] font-bold rounded uppercase tracking-wide">New</span>
              )}
            </div>
            {!isDeactivated && (profile.exact_job_title || profile.title || profile.company) && (
              <div className="flex items-center gap-1 text-xs text-slate-500 mt-0.5">
                <Briefcase className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{[profile.exact_job_title || profile.title, profile.company].filter(Boolean).join(' at ')}</span>
              </div>
            )}
            {isDeactivated && <FormerMemberBadge />}
            {profile.location && (
              <div className="flex items-center gap-1 text-xs text-slate-400 mt-0.5">
                <MapPin className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{profile.location}</span>
              </div>
            )}
          </div>
        </div>

        {!isDeactivated && profile.bio && (
          <p className="text-xs text-slate-500 leading-relaxed line-clamp-2">{profile.bio}</p>
        )}

        {connectedRelative && (
          <div className="text-xs text-slate-400">Introduced through Andrel · Connected {connectedRelative}</div>
        )}

        <div className="flex gap-2 pt-3 border-t border-slate-100">
          <button
            data-card-action
            type="button"
            onClick={handleMessageClick}
            disabled={navigatingToMessage}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-brand-navy text-white text-xs font-semibold rounded-lg hover:bg-brand-navy/90 transition-colors disabled:opacity-75"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            Message
          </button>
          <Link
            data-card-action
            href={`/dashboard/meetings?schedule=1&with=${profile.id}`}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border border-slate-200/70 text-slate-700 text-xs font-semibold rounded-lg hover:bg-slate-50 transition-colors"
          >
            <Calendar className="w-3.5 h-3.5" />
            Schedule
          </Link>
          <button
            data-card-action
            type="button"
            onClick={handleOpenDetails}
            aria-label="View full profile"
            className="flex items-center justify-center gap-1.5 px-3 py-2 border border-slate-200/70 text-slate-700 text-xs font-semibold rounded-lg hover:bg-slate-50 transition-colors"
          >
            <Eye className="w-3.5 h-3.5" />
            View
          </button>
        </div>
      </div>

      {modalOpen && (
        <ConnectionDetailModal
          matchId={matchId}
          profile={profile}
          connectedAt={connectedAt}
          matchInsights={matchInsights}
          conversationId={conversationId}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  )
}
