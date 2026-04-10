'use client'

import { useState } from 'react'
import { Calendar, Clock, Video, Plus, MapPin, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import ScheduleMeetingModal from './ScheduleMeetingModal'
import MeetingDetailModal, { MeetingDetail } from './MeetingDetailModal'

interface Meeting extends MeetingDetail {}

function toICSDate(iso: string) {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '').replace('Z', 'Z')
}

function downloadICS(m: Meeting) {
  const start = new Date(m.scheduled_at)
  const end = new Date(start.getTime() + m.duration_minutes * 60000)
  const now = new Date()
  const description = [m.notes, m.zoom_link ? `Meeting link: ${m.zoom_link}` : ''].filter(Boolean).join('\\n')
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Loque//Loque Networking//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:loque-meeting-${m.id}@loque.app`,
    `DTSTAMP:${toICSDate(now.toISOString())}`,
    `DTSTART:${toICSDate(start.toISOString())}`,
    `DTEND:${toICSDate(end.toISOString())}`,
    `SUMMARY:${m.title}`,
    description ? `DESCRIPTION:${description}` : '',
    m.zoom_link ? `URL:${m.zoom_link}` : '',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n')
  const blob = new Blob([lines], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${m.title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.ics`
  a.click()
  URL.revokeObjectURL(url)
}

function formatDate(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(today.getDate() + 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow'
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function formatTime(iso: string, duration: number) {
  const d = new Date(iso)
  const end = new Date(d.getTime() + duration * 60000)
  const fmt = (dt: Date) => dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `${fmt(d)} – ${fmt(end)}`
}

function initials(name?: string) {
  return name?.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase() || '?'
}

const AVATAR_COLORS = [
  'bg-[#1B2850]', 'bg-[#2E4080]', 'bg-amber-500', 'bg-rose-500',
  'bg-cyan-600', 'bg-teal-600', 'bg-pink-500', 'bg-slate-600',
]
function pickColor(id?: string) {
  if (!id) return 'bg-[#1B2850]'
  const n = id.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return AVATAR_COLORS[n % AVATAR_COLORS.length]
}

interface MatchedUser {
  id: string
  full_name: string
  title?: string
  company?: string
}

function getStatusBadge(status: string) {
  if (status === 'confirmed') {
    return { text: 'Confirmed', color: 'bg-green-100 text-green-700 border-green-200' }
  } else if (status === 'requested' || status === 'reschedule_requested') {
    return { text: status === 'reschedule_requested' ? 'Reschedule Pending' : 'Pending', color: 'bg-orange-100 text-orange-700 border-orange-200' }
  } else if (status === 'declined' || status === 'reschedule_declined') {
    return { text: status === 'reschedule_declined' ? 'Reschedule Declined' : 'Declined', color: 'bg-red-100 text-red-700 border-red-200' }
  }
  return { text: status, color: 'bg-gray-100 text-gray-700 border-gray-200' }
}


export default function MeetingsClient({
  upcoming,
  past,
  currentUserId,
  matchedUsers,
}: {
  upcoming: Meeting[]
  past: Meeting[]
  currentUserId: string
  matchedUsers: MatchedUser[]
}) {
  const [view, setView] = useState<'list' | 'calendar'>('list')
  const [showSchedule, setShowSchedule] = useState(false)
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null)

  const MeetingCard = ({ m, faded }: { m: Meeting; faded?: boolean }) => (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setSelectedMeeting(m)}
      onKeyDown={e => e.key === 'Enter' && setSelectedMeeting(m)}
      className={cn(
        'bg-white border border-slate-100 rounded-xl p-4 md:p-5 shadow-sm flex flex-col gap-3 cursor-pointer',
        'hover:border-slate-200 hover:shadow-md transition-all',
        faded && 'opacity-60'
      )}
    >
      {/* Top row: icon + info + avatar */}
      <div className="flex items-start gap-3">
        <div className={cn('w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5', faded ? 'bg-slate-100' : 'bg-[#F5F6FB]')}>
          <Calendar className={cn('w-4 h-4', faded ? 'text-slate-400' : 'text-[#1B2850]')} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-900 truncate">{m.title}</p>
          {m.other?.full_name && (
            <p className="text-xs text-slate-400 truncate mt-0.5">with {m.other.full_name}</p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
            <span className="flex items-center gap-1 text-xs text-slate-500">
              <Clock className="w-3 h-3" />
              {formatDate(m.scheduled_at)} · {formatTime(m.scheduled_at, m.duration_minutes)}
            </span>
            {m.meeting_type === 'virtual' || m.meeting_type === 'video' ? (
              <span className="flex items-center gap-1 text-xs text-[#1B2850] font-medium">
                <Video className="w-3 h-3" /> Virtual
              </span>
            ) : m.location ? (
              <span className="flex items-center gap-1 text-xs text-slate-500">
                <MapPin className="w-3 h-3" /> {m.location}
              </span>
            ) : null}
          </div>
        </div>
        {m.other && (
          <div className={`w-7 h-7 rounded-full ${pickColor(m.other.id)} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>
            {initials(m.other.full_name)}
          </div>
        )}
      </div>

      {/* Action buttons row — stop propagation so they don't open the detail modal */}
      {!faded && (
        <div className="flex items-center gap-2 pt-1 border-t border-slate-50">
          <button
            onClick={e => { e.stopPropagation(); downloadICS(m) }}
            className="flex-1 text-xs font-semibold border border-slate-200 text-slate-600 px-3 py-1.5 rounded-lg hover:border-slate-300 hover:text-slate-800 transition-colors text-center"
          >
            + Calendar
          </button>
          {m.zoom_link && (
            <a
              href={m.zoom_link}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="flex-1 text-xs font-semibold bg-[#1B2850] text-white px-3 py-1.5 rounded-lg hover:bg-[#2E4080] transition-colors text-center"
            >
              Join meeting
            </a>
          )}
        </div>
      )}
    </div>
  )

  return (
    <div className="p-4 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8">
      <div className="max-w-3xl">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Meetings</h1>
            <p className="text-slate-500 text-sm mt-0.5">Your scheduled conversations and calls.</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex bg-slate-100 p-0.5 rounded-lg">
              {(['list', 'calendar'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={cn(
                    'px-3 py-1.5 text-xs font-medium rounded-md capitalize transition-colors',
                    view === v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowSchedule(true)}
              className="flex items-center gap-2 bg-[#1B2850] text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-[#2E4080] transition-colors"
            >
              <Plus className="w-4 h-4" />
              Schedule
            </button>
          </div>
        </div>

        {view === 'calendar' && (
          <div className="bg-white border border-slate-100 rounded-xl shadow-sm mb-8 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="text-sm font-semibold text-slate-900">
                {new Date().toLocaleString('default', { month: 'long', year: 'numeric' })}
              </h2>
              <div className="flex items-center gap-1">
                <button className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors"><ChevronLeft className="w-4 h-4 text-slate-500" /></button>
                <button className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors"><ChevronRight className="w-4 h-4 text-slate-500" /></button>
              </div>
            </div>
            <div className="p-4 text-center text-sm text-slate-400">
              Calendar view coming soon. Switch to list to see your meetings.
            </div>
          </div>
        )}

        <div className="space-y-6">
          <div>
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Upcoming</h2>
            {upcoming.length === 0 ? (
              <div className="bg-white border border-slate-100 rounded-xl p-10 text-center shadow-sm">
                <div className="w-10 h-10 bg-[#F5F6FB] rounded-full flex items-center justify-center mx-auto mb-3">
                  <Calendar className="w-5 h-5 text-slate-400" />
                </div>
                <p className="text-sm font-semibold text-slate-600 mb-1">No upcoming meetings</p>
                <p className="text-xs text-slate-400 mb-4">Schedule a call with someone in your network.</p>
                <button
                  onClick={() => setShowSchedule(true)}
                  className="text-xs font-semibold bg-[#1B2850] text-white px-4 py-2 rounded-lg hover:bg-[#2E4080] transition-colors"
                >
                  Schedule meeting
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {upcoming.map(m => <MeetingCard key={m.id} m={m} />)}
              </div>
            )}
          </div>

          {past.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Past</h2>
              <div className="space-y-3">
                {past.map(m => <MeetingCard key={m.id} m={m} faded />)}
              </div>
            </div>
          )}
        </div>
      </div>

      {showSchedule && (
        <ScheduleMeetingModal
          onClose={() => setShowSchedule(false)}
          matchedUsers={matchedUsers}
        />
      )}

      {selectedMeeting && (
        <MeetingDetailModal
          meeting={selectedMeeting}
          onClose={() => setSelectedMeeting(null)}
        />
      )}
    </div>
  )
}
