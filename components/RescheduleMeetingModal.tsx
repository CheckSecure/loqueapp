'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import { rescheduleMeeting } from '@/app/actions'

interface MeetingData {
  id: string
  title: string
  scheduled_at: string
  duration_minutes: number
  meeting_type: string
  location?: string
  zoom_link?: string | null
  notes?: string | null
}

export default function RescheduleMeetingModal({
  meeting,
  onClose,
}: {
  meeting: MeetingData
  onClose: () => void
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const existingDate = new Date(meeting.scheduled_at).toISOString().slice(0, 10)
  const existingTime = new Date(meeting.scheduled_at).toTimeString().slice(0, 5)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const formData = new FormData(e.currentTarget)
    const result = await rescheduleMeeting(meeting.id, formData)
    if (result.error) {
      setError(result.error)
      setLoading(false)
    } else {
      router.refresh()
      onClose()
    }
  }

  const fieldClass = 'w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-brand-navy focus:ring-1 focus:ring-brand-navy/20 transition bg-white'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl border border-slate-200/70 w-full max-w-md p-6 sm:p-7 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between mb-6">
          <div>
            <p className="text-[10px] uppercase tracking-[0.18em] text-brand-gold font-bold mb-1">Andrel</p>
            <h2 className="text-lg font-bold text-brand-navy tracking-tight">Reschedule meeting</h2>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors -mt-1 -mr-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input type="hidden" name="timezone_offset" value={new Date().getTimezoneOffset().toString()} />
          {error && (
            <div className="p-3 bg-red-50 border border-red-100 rounded-lg text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">Date *</label>
              <input type="date" name="date" required defaultValue={existingDate} className={fieldClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">Time *</label>
              <input type="time" name="time" required defaultValue={existingTime} className={fieldClass} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">Duration</label>
              <select name="duration_minutes" defaultValue={meeting.duration_minutes} className={fieldClass}>
                <option value="30">30 minutes</option>
                <option value="45">45 minutes</option>
                <option value="60">60 minutes</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">Format</label>
              <select name="format" defaultValue={meeting.meeting_type} className={fieldClass}>
                <option value="virtual">Virtual</option>
                <option value="in-person">In-person</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              Meeting link <span className="text-slate-400 font-normal text-xs ml-1">for virtual</span>
            </label>
            <input
              name="zoom_link"
              type="url"
              defaultValue={meeting.zoom_link || ''}
              placeholder="Zoom, Google Meet, or Teams URL"
              className={fieldClass}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              Location <span className="text-slate-400 font-normal text-xs ml-1">for in-person</span>
            </label>
            <input
              name="location"
              type="text"
              defaultValue={meeting.location || ''}
              placeholder="e.g. Starbucks, 123 Main St, NYC"
              className={fieldClass}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">Notes <span className="text-slate-400 font-normal text-xs ml-1">optional</span></label>
            <textarea
              name="notes"
              rows={3}
              defaultValue={meeting.notes || ''}
              placeholder="Any context or agenda items..."
              className={fieldClass}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-brand-navy text-white py-2.5 rounded-lg font-semibold hover:bg-brand-navy/90 shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Rescheduling...' : 'Reschedule meeting'}
          </button>
        </form>
      </div>
    </div>
  )
}
