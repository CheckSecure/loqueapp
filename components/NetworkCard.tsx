'use client'

import { useState } from 'react'
import { Briefcase, MapPin, MessageSquare, Calendar, Eye } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import ConnectionDetailModal from '@/components/network/ConnectionDetailModal'

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

  const avatarColor = pickColor(profile.id)
  const initials = getInitials(profile.full_name)
  const connectedDate = connectedAt
    ? new Date(connectedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null

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
          highlighted ? 'border-[#C4922A] bg-[#FDF9F3]' : 'border-slate-100'
        }`}
      >
        <div className="flex items-start gap-3">
          {profile.avatar_url ? (
            <img src={profile.avatar_url} alt={profile.full_name} className="w-11 h-11 rounded-full object-cover flex-shrink-0" />
          ) : (
            <div className={`w-11 h-11 rounded-full ${avatarColor} flex items-center justify-center text-white text-sm font-bold flex-shrink-0`}>
              {initials}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-slate-900 truncate">{profile.full_name}</p>
              {highlighted && (
                <span className="px-1.5 py-0.5 bg-[#C4922A] text-white text-[10px] font-bold rounded uppercase">New</span>
              )}
            </div>
            {(profile.title || profile.company) && (
              <div className="flex items-center gap-1 text-xs text-slate-500 mt-0.5">
                <Briefcase className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{[profile.title, profile.company].filter(Boolean).join(' at ')}</span>
              </div>
            )}
            {profile.location && (
              <div className="flex items-center gap-1 text-xs text-slate-400 mt-0.5">
                <MapPin className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{profile.location}</span>
              </div>
            )}
          </div>
        </div>

        {profile.bio && (
          <p className="text-xs text-slate-500 leading-relaxed line-clamp-2">{profile.bio}</p>
        )}

        {connectedAt && connectedDate && connectedDate !== 'Jan 1, 1970' && (
          <div className="text-xs text-slate-400">Connected {connectedDate}</div>
        )}

        <div className="flex gap-2 pt-1 border-t border-slate-50">
          <button
            data-card-action
            type="button"
            onClick={handleMessageClick}
            disabled={navigatingToMessage}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-[#1B2850] text-white text-xs font-semibold rounded-lg hover:bg-[#162040] transition-colors disabled:opacity-75"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            Message
          </button>
          <Link
            data-card-action
            href={`/dashboard/meetings?schedule=1&with=${profile.id}`}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border border-slate-200 text-slate-600 text-xs font-semibold rounded-lg hover:bg-slate-50 transition-colors"
          >
            <Calendar className="w-3.5 h-3.5" />
            Schedule
          </Link>
          <button
            data-card-action
            type="button"
            onClick={handleOpenDetails}
            aria-label="View full profile"
            className="flex items-center justify-center gap-1.5 px-3 py-2 border border-slate-200 text-slate-600 text-xs font-semibold rounded-lg hover:bg-slate-50 transition-colors"
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
