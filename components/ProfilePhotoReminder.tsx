'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Camera } from 'lucide-react'
import {
  PHOTO_REMINDER_KEY,
  parseState,
  shouldShowPhotoReminder,
  nextDismissState,
} from '@/lib/photoReminder'

/**
 * Low-friction, dismissible profile-photo reminder.
 *
 * Not a modal / tour / blocker; not in the bell; no email. Shown only when the
 * member has no avatar and the escalating snooze (21d → 45d → permanent) hasn't
 * silenced it. Uploading a photo suppresses it permanently (hasPhoto=true → next
 * server render passes true and this returns null, regardless of stored state).
 */
export default function ProfilePhotoReminder({ hasPhoto }: { hasPhoto: boolean }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (hasPhoto) return
    try {
      const state = parseState(localStorage.getItem(PHOTO_REMINDER_KEY))
      if (shouldShowPhotoReminder(hasPhoto, state, Date.now())) setVisible(true)
    } catch {
      // localStorage unavailable (private mode) — show anyway; just won't persist.
      setVisible(true)
    }
  }, [hasPhoto])

  function maybeLater() {
    try {
      const state = parseState(localStorage.getItem(PHOTO_REMINDER_KEY))
      const next = nextDismissState(state, Date.now())
      localStorage.setItem(PHOTO_REMINDER_KEY, JSON.stringify(next))
    } catch {
      // best-effort; if it can't persist, just hide for this session
    }
    setVisible(false)
  }

  if (hasPhoto || !visible) return null

  return (
    <div
      role="region"
      aria-label="Add your profile photo"
      className="mb-6 rounded-2xl border border-brand-gold/20 bg-white p-4 shadow-sm sm:p-5"
    >
      <div className="flex items-start gap-3 sm:gap-4">
        <div className="hidden h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-brand-gold-soft text-brand-gold sm:flex">
          <Camera className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-brand-navy">Help people recognize you</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-600 sm:text-sm">
            Add a profile photo so new connections can put a face to your name.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <Link
              href="/dashboard/profile"
              className="inline-flex items-center rounded-lg bg-brand-navy px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-navy-dark"
            >
              Add photo
            </Link>
            <button
              type="button"
              onClick={maybeLater}
              className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-700"
            >
              Maybe later
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
