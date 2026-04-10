'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { X, Calendar, Clock, Video, MapPin, FileText, ExternalLink, Trash2, CheckCircle, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { deleteMeeting, acceptMeeting, declineMeeting } from '@/app/actions'
import RescheduleMeetingModal from './RescheduleMeetingModal'

const AVATAR_COLORS = [
  'bg-[#1B2850]', 'bg-[#2E4080]', 'bg-amber-500', 'bg-rose-500',
  'bg-cyan-600', 'bg-teal-600', 'bg-pink-500', 'bg-slate-600',
]
function pickColor(id?: string) {
  if (!id) return 'bg-[#1B2850]'
  const n = id.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return AVATAR_COLORS[n % AVATAR_COLORS.length]
}
function initials(name?: string) {
  return name?.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase() || '?'
}
function formatFullDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })
}
function formatTimeRange(iso: string, duration: number) {
  const d = new Date(iso)
  const end = new Date(d.getTime() + duration * 60000)
  const fmt = (dt: Date) => dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `${fmt(d)} – ${fmt(end)}`
}
function toICSDate(iso: string) {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '').replace('Z', 'Z')
}

export interface MeetingDetail {
  id: string
  title: string
  scheduled_at: string
  duration_minutes: number
  meeting_type: string
  status: string
  location?: string
  zoom_link?: string | null
  notes?: string | null
  other?: { id: string; full_name: string; title?: string; company?: string } | null
  isOrganizer: boolean
  isPast: boolean
}

function downloadICS(m: MeetingDetail) {
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

export default function MeetingDetailModal({
  meeting,
  onClose,
}: {
  meeting: MeetingDetail
  onClose: () => void
}) {
  const router = useRouter()
  const [visible, setVisible] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showReschedule, setShowReschedule] = useState(false)

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true))
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.body.style.overflow = ''
    }
  }, [onClose])

  const handleClose = () => {
    setVisible(false)
    setTimeout(onClose, 250)
  }

  const goToProfile = () => {
    if (meeting.other?.id) {
      handleClose()
      setTimeout(() => router.push(`/dashboard/profile/${meeting.other!.id}`), 260)
    }
  }

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this meeting? This cannot be undone.')) return
    setDeleting(true)
    const result = await deleteMeeting(meeting.id)
    if (result.success) {
      router.refresh()
      handleClose()
    } else {
      alert(result.error || 'Failed to delete meeting')
      setDeleting(false)
    }
  }

  return (
    <>
        <div className="fixed inset-0 z-50 flex items-end md:items-stretch">
      {/* Backdrop */}
      <div
        className={cn(
          'absolute inset-0 bg-black/40 backdrop-blur-[2px] transition-opacity duration-250',
          visible ? 'opacity-100' : 'opacity-0'
        )}
        onClick={handleClose}
      />

      {/* Panel: bottom sheet on mobile, right side panel on desktop */}
      <div
        className={cn(
          'relative w-full md:w-[420px] md:ml-auto bg-white shadow-2xl flex flex-col',
          'rounded-t-2xl md:rounded-none',
          'max-h-[92vh] md:max-h-full md:h-full',
          'transition-transform duration-250 ease-out',
          visible
            ? 'translate-y-0 md:translate-x-0'
            : 'translate-y-full md:translate-x-full md:translate-y-0'
        )}
      >
        {/* Drag handle — mobile only */}
        <div className="md:hidden flex justify-center pt-3 pb-1 flex-shrink-0">
          <div className="w-10 h-1 rounded-full bg-slate-200" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 flex-shrink-0">
          <h2 className="text-sm font-semibold text-slate-900">Meeting details</h2>
          <button
            onClick={handleClose}
            className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center transition-colors"
          >
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-5 py-5 space-y-6">

            {/* Person profile card */}
            {meeting.other && (
              <button
                onClick={goToProfile}
                className="w-full flex items-center gap-4 p-4 bg-[#F5F6FB] rounded-2xl hover:bg-slate-100 transition-colors text-left group"
              >
                <div className={cn(
                  'w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-base flex-shrink-0',
                  pickColor(meeting.other.id)
                )}>
                  {initials(meeting.other.full_name)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-900 truncate group-hover:text-[#1B2850] transition-colors">
                    {meeting.other.full_name}
                  </p>
                  {(meeting.other.title || meeting.other.company) && (
                    <p className="text-xs text-slate-500 truncate mt-0.5">
                      {[meeting.other.title, meeting.other.company].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  <p className="text-xs text-[#C4922A] font-medium mt-1.5">View profile →</p>
                </div>
              </button>
            )}

            {/* Topic */}
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Topic</p>
              <p className="text-base font-semibold text-slate-900 leading-snug">{meeting.title}</p>
              {meeting.isPast && (
                <span className="inline-block mt-2 text-xs font-medium text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">Past meeting</span>
              )}
            </div>

            {/* Date & time */}
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-[#F5F6FB] flex items-center justify-center flex-shrink-0">
                <Calendar className="w-4 h-4 text-[#1B2850]" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900">{formatFullDate(meeting.scheduled_at)}</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {formatTimeRange(meeting.scheduled_at, meeting.duration_minutes)} · {meeting.duration_minutes} min
                </p>
              </div>
            </div>

            {/* Format / location */}
            {(meeting.meeting_type === 'virtual' || meeting.meeting_type === 'video') ? (
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-[#F5F6FB] flex items-center justify-center flex-shrink-0">
                  <Video className="w-4 h-4 text-[#1B2850]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-900">Virtual meeting</p>
                  {meeting.zoom_link && (
                    <a
                      href={meeting.zoom_link}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="mt-1 flex items-center gap-1 text-xs text-[#C4922A] font-medium hover:underline truncate"
                    >
                      <ExternalLink className="w-3 h-3 flex-shrink-0" />
                      <span className="truncate">{meeting.zoom_link}</span>
                    </a>
                  )}
                </div>
              </div>
            ) : meeting.location ? (
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-[#F5F6FB] flex items-center justify-center flex-shrink-0">
                  <MapPin className="w-4 h-4 text-[#1B2850]" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900">In person</p>
                  <p className="text-xs text-slate-500 mt-0.5">{meeting.location}</p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-[#F5F6FB] flex items-center justify-center flex-shrink-0">
                  <Clock className="w-4 h-4 text-[#1B2850]" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900 capitalize">
                    {meeting.meeting_type || 'Meeting'}
                  </p>
                </div>
              </div>
            )}

            {/* Notes */}
            {meeting.notes && (
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-[#F5F6FB] flex items-center justify-center flex-shrink-0">
                  <FileText className="w-4 h-4 text-[#1B2850]" />
                </div>
                <div className="flex-1">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Notes</p>
                  <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{meeting.notes}</p>
                </div>
              </div>
            )}
          </div>
        
          {meeting.status === 'requested' && !meeting.isOrganizer && !meeting.isPast && (
            <div className="flex gap-2 mb-3">
              <button
                onClick={handleAccept}
                disabled={deleting}
                className="flex-1 flex items-center justify-center gap-2 text-sm font-semibold bg-green-600 text-white px-4 py-2.5 rounded-xl hover:bg-green-700 transition-colors disabled:opacity-50"
              >
                <CheckCircle className="w-4 h-4" />
                Accept
              </button>
              <button
                onClick={handleDecline}
                disabled={deleting}
                className="flex-1 flex items-center justify-center gap-2 text-sm font-semibold bg-red-600 text-white px-4 py-2.5 rounded-xl hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                <XCircle className="w-4 h-4" />
                Decline
              </button>
            </div>
          )}

          <button
            onClick={() => setShowReschedule(true)}
            className="w-full text-sm font-semibold border border-slate-200 text-slate-600 px-4 py-2.5 rounded-xl hover:border-slate-300 hover:text-slate-800 transition-colors flex items-center justify-center gap-2 mb-3"
          >
            Reschedule
          </button>

          <button
            onClick={handleDelete}
            disabled={deleting}
            className="w-full text-sm font-semibold border border-red-200 text-red-600 px-4 py-2.5 rounded-xl hover:bg-red-50 hover:border-red-300 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 mt-3"
          >
            <Trash2 className="w-4 h-4" />
            {deleting ? 'Deleting...' : 'Delete Meeting'}
          </button>
        </div>

        {/* Footer actions */}
        <div className="flex-shrink-0 px-5 pb-safe-or-6 pb-6 pt-4 border-t border-slate-100 flex gap-3">
          <button
            onClick={() => downloadICS(meeting)}
            className="flex-1 text-sm font-semibold border border-slate-200 text-slate-600 px-4 py-2.5 rounded-xl hover:border-slate-300 hover:text-slate-800 transition-colors"
          >
            + Calendar
          </button>
          {meeting.zoom_link && !meeting.isPast && (
            <a
              href={meeting.zoom_link}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 text-sm font-semibold bg-[#1B2850] text-white px-4 py-2.5 rounded-xl hover:bg-[#2E4080] transition-colors text-center"
            >
              Join meeting
            </a>
          )}
        </div>
      </div>
    </div>

      {showReschedule && (
        <RescheduleMeetingModal
          meeting={meeting}
          onClose={() => setShowReschedule(false)}
        />
      )}
    </>

  )
}

  const handleAccept = async () => {
    setDeleting(true)
    const result = await acceptMeeting(meeting.id)
    if (result.success) {
      router.refresh()
      handleClose()
    } else {
      alert(result.error || 'Failed to accept meeting')
      setDeleting(false)
    }
  }

  const handleDecline = async () => {
    setDeleting(true)
    const result = await declineMeeting(meeting.id)
    if (result.success) {
      router.refresh()
      handleClose()
    } else {
      alert(result.error || 'Failed to decline meeting')
      setDeleting(false)
    }
  }
