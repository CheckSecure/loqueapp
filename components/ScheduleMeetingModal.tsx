'use client'

import { useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import { scheduleMeeting } from '@/app/actions'
import { useRouter } from 'next/navigation'

const PURPOSES = ['Networking', 'Business development', 'Mentorship', 'Referral', 'Collaboration']

interface MatchedUser {
  id: string
  full_name: string
  title?: string
  company?: string
}

export default function ScheduleMeetingModal({
  onClose,
  matchedUsers,
  initialRecipientId,
}: {
  onClose: () => void
  matchedUsers: MatchedUser[]
  initialRecipientId?: string
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tomorrow = new Date(Date.now() + 86400000)
  const defaultDate = tomorrow.toISOString().slice(0, 10)
  const defaultTime = '10:00'

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const formData = new FormData(e.currentTarget)
    console.log('[ScheduleModal] FormData - format:', formData.get('format'))
    console.log('[ScheduleModal] FormData - location:', formData.get('location'))
    console.log('[ScheduleModal] FormData - purpose:', formData.get('purpose'))
    const result = await scheduleMeeting(formData)
    if (result.error) {
      setError(result.error)
      setLoading(false)
    } else {
      router.refresh()
      onClose()
    }
  }

  const fieldClass =
    'w-full px-3.5 py-2.5 border border-slate-200 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-brand-navy focus:ring-1 focus:ring-brand-navy/20 transition bg-white'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl border border-slate-200/70 w-full max-w-md p-6 sm:p-7 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between mb-6">
          <div>
            <p className="text-[10px] uppercase tracking-[0.18em] text-brand-gold font-bold mb-1">Andrel</p>
            <h2 className="text-lg font-bold text-brand-navy tracking-tight">Schedule a meeting</h2>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors -mt-1 -mr-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input type="hidden" name="timezone_offset" value={new Date().getTimezoneOffset().toString()} />
          {error && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-100 px-3 py-2.5 rounded-lg">
              {error}
            </p>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              Meeting with <span className="text-brand-gold">*</span>
            </label>
            <select name="recipient_id" required defaultValue={initialRecipientId || ""} className={fieldClass}>
              <option value="">Select a connection…</option>
              {matchedUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}
                  {u.title || u.company ? ` — ${[u.title, u.company].filter(Boolean).join(', ')}` : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              Meeting title <span className="text-slate-400 font-normal text-xs ml-1">optional</span>
            </label>
            <input
              name="title"
              type="text"
              placeholder="e.g. Intro call, Strategy discussion…"
              className={fieldClass}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              Purpose <span className="text-brand-gold">*</span>
            </label>
            <select name="purpose" required defaultValue="" className={fieldClass}>
              <option value="" disabled>Select a purpose…</option>
              {PURPOSES.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">
                Date <span className="text-brand-gold">*</span>
              </label>
              <input
                name="date"
                type="date"
                required
                defaultValue={defaultDate}
                className={fieldClass}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">
                Time <span className="text-brand-gold">*</span>
              </label>
              <input
                name="time"
                type="time"
                required
                defaultValue={defaultTime}
                className={fieldClass}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">Duration</label>
              <select name="duration_minutes" defaultValue="30" className={fieldClass}>
                <option value="30">30 minutes</option>
                <option value="45">45 minutes</option>
                <option value="60">60 minutes</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">Format</label>
              <select 
                name="format" 
                defaultValue="virtual" 
                className={fieldClass}
                onChange={(e) => console.log('[ScheduleModal] Format changed to:', e.target.value)}
              >
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
              placeholder="e.g. Starbucks, 123 Main St, NYC"
              className={fieldClass}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              Notes <span className="text-slate-400 font-normal text-xs ml-1">optional</span>
            </label>
            <textarea
              name="notes"
              rows={3}
              placeholder="Any context or agenda items…"
              className={`${fieldClass} resize-none`}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 bg-brand-navy text-white text-sm font-semibold py-2.5 rounded-lg hover:bg-brand-navy/90 shadow-sm transition-colors disabled:opacity-60 mt-2"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {loading ? 'Saving…' : 'Schedule meeting'}
          </button>
        </form>
      </div>
    </div>
  )
}
