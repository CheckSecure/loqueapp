'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { X, Calendar, Clock, Video, MapPin, FileText, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { downloadMeetingICS } from '@/lib/ics'
import { deleteMeeting, acceptMeeting, declineMeeting } from '@/app/actions'
import RescheduleMeetingModal from './RescheduleMeetingModal'
import { Button } from '@/components/ui/Button'

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
function getTimezoneAbbr() {
  const d = new Date()
  const tzString = d.toLocaleString('en-US', { timeZoneName: 'short' })
  const match = tzString.match(/\b([A-Z]{3,4})\b/)
  return match ? match[1] : ''
}

function formatTimeRange(iso: string, duration: number) {
  const d = new Date(iso)
  const end = new Date(d.getTime() + duration * 60000)
  const fmt = (dt: Date) => dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `${fmt(d)} – ${fmt(end)}`
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
  proposed_scheduled_at?: string | null
  proposed_duration_minutes?: number | null
  proposed_format?: string | null
  proposed_location?: string | null
  proposed_zoom_link?: string | null
  proposed_notes?: string | null
  other?: { id: string; full_name: string; title?: string; exact_job_title?: string | null; company?: string; avatar_url?: string | null } | null
  isOrganizer: boolean
  isPast: boolean
  isNew?: boolean
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

  // Invite response: the recipient of the original meeting request needs to respond.
  const showInviteResponse =
    meeting.status === 'requested' &&
    !meeting.isOrganizer &&
    !meeting.isPast

  // Reschedule response: a proposed time exists and is in the future.
  // Gate on proposed_scheduled_at being future — NOT on isPast (which reflects the original time
  // and would hide these buttons even when the proposed slot is upcoming).
  // Both parties can see Accept/Decline; without a reschedule_proposer_id column there is no
  // data-model way to gate out the proposer, so we match the original pre-refactor behaviour.
  const showRescheduleResponse =
    meeting.status === 'reschedule_requested' &&
    Boolean(meeting.proposed_scheduled_at) &&
    new Date(meeting.proposed_scheduled_at!) > new Date()

  const showAcceptDecline = showInviteResponse || showRescheduleResponse
  const canReschedule = !meeting.isPast
  const showJoinMeeting = Boolean(meeting.zoom_link) && !meeting.isPast

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-end md:items-stretch">
      {/* Backdrop */}
      <div
        className={cn(
          'absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity duration-250',
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
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-100 flex-shrink-0">
          <div>
            <p className="text-[10px] uppercase tracking-[0.18em] text-brand-gold font-bold mb-0.5">Andrel</p>
            <h2 className="text-sm font-semibold text-brand-navy">Meeting details</h2>
          </div>
          <button
            onClick={handleClose}
            aria-label="Close"
            className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center transition-colors -mt-0.5"
          >
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>

        {/* Scrollable body — content only */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-5 py-6 space-y-6">

            {/* Person profile card */}
            {meeting.other && (
              <button
                onClick={goToProfile}
                className="w-full flex items-center gap-4 p-4 bg-brand-cream/40 border border-brand-gold/15 rounded-2xl hover:bg-brand-cream/60 transition-colors text-left group"
              >
                {meeting.other.avatar_url ? (
                  <img
                    src={meeting.other.avatar_url}
                    alt={meeting.other.full_name}
                    className="w-12 h-12 rounded-full object-cover ring-1 ring-slate-200 flex-shrink-0"
                  />
                ) : (
                  <div className={cn(
                    'w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-base flex-shrink-0',
                    pickColor(meeting.other.id)
                  )}>
                    {initials(meeting.other.full_name)}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-brand-navy truncate group-hover:text-brand-navy/80 transition-colors">
                    {meeting.other.full_name}
                  </p>
                  {(meeting.other.exact_job_title || meeting.other.title || meeting.other.company) && (
                    <p className="text-xs text-slate-500 truncate mt-0.5">
                      {[meeting.other.exact_job_title || meeting.other.title, meeting.other.company].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  <p className="text-xs text-brand-gold font-medium mt-1.5">View profile →</p>
                </div>
              </button>
            )}

            {/* Topic */}
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Topic</p>
              <p className="text-base font-semibold text-brand-navy leading-snug">{meeting.title}</p>
              {meeting.isPast && (
                <span className="inline-block mt-2 text-xs font-medium text-slate-500 bg-slate-100 px-2.5 py-0.5 rounded-full">Past meeting</span>
              )}
            </div>

            {/* Date & time — Add to Calendar sits directly below */}
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-brand-navy/[0.06] flex items-center justify-center flex-shrink-0">
                <Calendar className="w-4 h-4 text-brand-navy" />
              </div>
              <div className="flex-1">
                {meeting.proposed_scheduled_at ? (
                  <>
                    <p className="text-sm font-semibold text-slate-400 line-through">
                      Current: {formatFullDate(meeting.scheduled_at)}
                    </p>
                    <p className="text-xs text-slate-400 line-through mt-0.5">
                      {formatTimeRange(meeting.scheduled_at, meeting.duration_minutes)} {getTimezoneAbbr()} · {meeting.duration_minutes} min
                    </p>
                    <p className="text-sm font-semibold text-brand-navy mt-2">
                      Proposed: {formatFullDate(meeting.proposed_scheduled_at)}
                    </p>
                    <p className="text-xs text-brand-navy mt-0.5">
                      {formatTimeRange(meeting.proposed_scheduled_at, meeting.proposed_duration_minutes || meeting.duration_minutes)} {getTimezoneAbbr()} · {meeting.proposed_duration_minutes || meeting.duration_minutes} min
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-semibold text-slate-900">{formatFullDate(meeting.scheduled_at)}</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {formatTimeRange(meeting.scheduled_at, meeting.duration_minutes)} {getTimezoneAbbr()} · {meeting.duration_minutes} min
                    </p>
                  </>
                )}
                <button
                  onClick={() => downloadMeetingICS(meeting)}
                  className="mt-2 text-xs text-brand-gold font-medium hover:underline"
                >
                  Add to Calendar
                </button>
              </div>
            </div>

            {/* Format / location */}
            {(meeting.meeting_type === 'virtual' || meeting.meeting_type === 'video') ? (
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-brand-navy/[0.06] flex items-center justify-center flex-shrink-0">
                  <Video className="w-4 h-4 text-brand-navy" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-900">Virtual meeting</p>
                  {meeting.zoom_link && (
                    <a
                      href={meeting.zoom_link}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="mt-1 flex items-center gap-1 text-xs text-brand-gold font-medium hover:underline truncate"
                    >
                      <ExternalLink className="w-3 h-3 flex-shrink-0" />
                      <span className="truncate">{meeting.zoom_link}</span>
                    </a>
                  )}
                </div>
              </div>
            ) : meeting.location ? (
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-brand-navy/[0.06] flex items-center justify-center flex-shrink-0">
                  <MapPin className="w-4 h-4 text-brand-navy" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900">In person</p>
                  <p className="text-xs text-slate-500 mt-0.5">{meeting.location}</p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-brand-navy/[0.06] flex items-center justify-center flex-shrink-0">
                  <Clock className="w-4 h-4 text-brand-navy" />
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
                <div className="w-9 h-9 rounded-xl bg-brand-navy/[0.06] flex items-center justify-center flex-shrink-0">
                  <FileText className="w-4 h-4 text-brand-navy" />
                </div>
                <div className="flex-1">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Notes</p>
                  <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{meeting.notes}</p>
                </div>
              </div>
            )}

          </div>
        </div>

        {/* Fixed bottom actions */}
        <div className="flex-shrink-0 px-5 pt-5 pb-safe-or-6 pb-6 border-t border-slate-100 space-y-3">

          {/* Primary: Accept — label differs between initial invite and reschedule proposal */}
          {showAcceptDecline && (
            <Button
              variant="primary"
              onClick={handleAccept}
              disabled={deleting}
              className="w-full"
            >
              {showRescheduleResponse ? 'Accept New Time' : 'Accept Meeting'}
            </Button>
          )}

          {/* Primary (when no pending response): Join Meeting */}
          {!showAcceptDecline && showJoinMeeting && (
            <a
              href={meeting.zoom_link!}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-full items-center justify-center rounded-xl font-medium transition-colors px-4 py-2.5 text-sm bg-brand-navy text-white hover:bg-brand-navy-dark"
            >
              Join Meeting
            </a>
          )}

          {/* Join Meeting as secondary — when pending response and zoom link present */}
          {showAcceptDecline && showJoinMeeting && (
            <a
              href={meeting.zoom_link!}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-full items-center justify-center rounded-xl font-medium transition-colors px-4 py-2.5 text-sm bg-white border border-brand-navy text-brand-navy hover:bg-brand-navy hover:text-white"
            >
              Join Meeting
            </a>
          )}

          {/* Secondary: Decline (when response needed) + Reschedule (when not past) */}
          {(showAcceptDecline || canReschedule) && (
            <div className="flex gap-2">
              {showAcceptDecline && (
                <Button
                  variant="ghost"
                  onClick={handleDecline}
                  disabled={deleting}
                  className="flex-1"
                >
                  {showRescheduleResponse ? 'Decline Reschedule' : 'Decline'}
                </Button>
              )}
              {(canReschedule || showRescheduleResponse) && (
                <Button
                  variant="ghost"
                  onClick={() => setShowReschedule(true)}
                  className={showAcceptDecline ? 'flex-1' : 'w-full'}
                >
                  {showRescheduleResponse ? 'Propose Another Time' : 'Reschedule'}
                </Button>
              )}
            </div>
          )}

          {/* Destructive: Delete Meeting — lowest visual emphasis */}
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="w-full text-sm font-medium text-red-600 hover:text-red-700 transition-colors disabled:opacity-50 py-1"
          >
            {deleting ? 'Deleting…' : 'Delete Meeting'}
          </button>

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
