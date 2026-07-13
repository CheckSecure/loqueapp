'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Camera, X } from 'lucide-react'

// localStorage-only dismissal. Versioned so copy/design changes can re-surface
// it later by bumping the suffix.
const STORAGE_KEY = 'andrel_profile_photo_reminder_v1'

/**
 * Lightweight, dismissible "add a profile photo" nudge (LinkedIn-style).
 *
 * Not a modal / tour / blocker. Rendered inline near the top of the
 * Introductions page (which is only reachable after onboarding is complete).
 *
 * Shows only when: the member has no avatar (`hasPhoto === false`) AND hasn't
 * dismissed it. If a photo is uploaded, `hasPhoto` becomes true on the next
 * server render and this returns null — so it never reappears regardless of the
 * localStorage flag. No DB writes.
 */
export default function ProfilePhotoReminder({ hasPhoto }: { hasPhoto: boolean }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (hasPhoto) return
    try {
      if (!localStorage.getItem(STORAGE_KEY)) setVisible(true)
    } catch {
      // localStorage unavailable (private mode) — show anyway; just won't persist.
      setVisible(true)
    }
  }, [hasPhoto])

  function dismiss() {
    try {
      localStorage.setItem(STORAGE_KEY, '1')
    } catch {
      /* best-effort */
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
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-bold text-brand-navy">Add your profile photo</p>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss profile photo reminder"
              className="-mr-1 -mt-1 flex-shrink-0 rounded-full p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-slate-600 sm:text-sm">
            Members are significantly more likely to accept introductions when they can see who they&apos;re meeting.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <Link
              href="/dashboard/profile"
              className="inline-flex items-center rounded-lg bg-brand-navy px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-navy-dark"
            >
              Upload photo
            </Link>
            <button
              type="button"
              onClick={dismiss}
              className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-700"
            >
              Later
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
