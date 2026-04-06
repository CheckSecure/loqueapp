'use client'

import { useEffect, useState } from 'react'
import { Briefcase, MapPin, MessageSquare, Calendar } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

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
}

export default function NetworkCard({ matchId, profile, connectedAt, isNew }: NetworkCardProps) {
  const [highlighted, setHighlighted] = useState(isNew)
  const router = useRouter()
  
  const avatarColor = pickColor(profile.id)
  const initials = getInitials(profile.full_name)
  const connectedDate = connectedAt ? new Date(connectedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null

  const handleCardClick = (e: React.MouseEvent) => {
    // Don't navigate if clicking on action buttons
    const target = e.target as HTMLElement
    if (target.closest('a')) return
    
    // Mark as viewed (remove highlight)
    setHighlighted(false)
    
    // Navigate to profile
    router.push(`/dashboard/profile/${profile.id}`)
  }

  return (
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
            <p className="text-sm font-semibold text-slate-900">{profile.full_name}</p>
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
              <span>{profile.location}</span>
            </div>
          )}
        </div>
      </div>

      {profile.bio && (
        <p className="text-xs text-slate-500 leading-relaxed line-clamp-2">{profile.bio}</p>
      )}

      {connectedAt && connectedDate && connectedDate !== "January 1, 1970" && (
        <div className="text-xs text-slate-400">Connected {connectedDate}</div>
      )}

      <div className="flex gap-2 pt-1 border-t border-slate-50">
        <Link
          href="/dashboard/messages"
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-[#1B2850] text-white text-xs font-semibold rounded-lg hover:bg-[#162040] transition-colors"
        >
          <MessageSquare className="w-3.5 h-3.5" />
          Message
        </Link>
        <Link
          href="/dashboard/meetings"
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border border-slate-200 text-slate-600 text-xs font-semibold rounded-lg hover:bg-slate-50 transition-colors"
        >
          <Calendar className="w-3.5 h-3.5" />
          Schedule
        </Link>
      </div>
    </div>
  )
}
