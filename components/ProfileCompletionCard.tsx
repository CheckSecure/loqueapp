'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, Circle } from 'lucide-react'
import {
  COMPLETION_ITEMS as ITEMS,
  completionPercent,
  type ProfileCompletionFields,
} from '@/lib/profileCompletion'

// localStorage-only dismissal, versioned.
const STORAGE_KEY = 'andrel_profile_completion_card_v1'

export type { ProfileCompletionFields }

/**
 * Lightweight profile-completion progress card (not a blocker).
 *
 * Percentage is derived from `fields`, which the server computes from the
 * member's profile — so the bar and checklist update automatically after edits
 * on the next render. Hidden at 100% regardless of the localStorage flag; below
 * 100% it shows until dismissed. No DB writes.
 */
export default function ProfileCompletionCard({ fields }: { fields: ProfileCompletionFields }) {
  const [dismissed, setDismissed] = useState<boolean | null>(null)

  const percent = completionPercent(fields)
  const complete = percent >= 100

  useEffect(() => {
    try {
      setDismissed(!!localStorage.getItem(STORAGE_KEY))
    } catch {
      setDismissed(false)
    }
  }, [])

  function dismiss() {
    try {
      localStorage.setItem(STORAGE_KEY, '1')
    } catch {
      /* best-effort */
    }
    setDismissed(true)
  }

  // Complete → never show (ignores localStorage). Otherwise wait for the mount
  // check, then honor dismissal.
  if (complete || dismissed !== false) return null

  return (
    <div
      role="region"
      aria-label="Profile completion"
      className="mb-6 rounded-2xl border border-brand-gold/20 bg-white p-5 shadow-sm sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-brand-navy">Complete your profile</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-600 sm:text-sm">
            A complete profile helps us make stronger introductions for you and gives other members more context before connecting.
          </p>
        </div>
      </div>

      {/* Progress */}
      <div className="mt-4 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-brand-gold transition-all duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span
          className="text-xs font-semibold text-brand-navy"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Profile ${percent}% complete`}
        >
          {percent}% Complete
        </span>
      </div>

      {/* Checklist */}
      <ul className="mt-4 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {ITEMS.map((item) => {
          const done = fields[item.key]
          return (
            <li key={item.key} className="flex items-center gap-2 text-sm">
              {done ? (
                <Check className="h-4 w-4 flex-shrink-0 text-brand-gold" aria-hidden="true" />
              ) : (
                <Circle className="h-4 w-4 flex-shrink-0 text-slate-300" aria-hidden="true" />
              )}
              <span className={done ? 'text-slate-500' : 'text-slate-700'}>{item.label}</span>
              <span className="sr-only">{done ? 'completed' : 'not completed'}</span>
            </li>
          )
        })}
      </ul>

      {/* Actions */}
      <div className="mt-5 flex items-center gap-3">
        <Link
          href="/dashboard/profile"
          className="inline-flex items-center rounded-lg bg-brand-navy px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-navy-dark"
        >
          Complete profile
        </Link>
        <button
          type="button"
          onClick={dismiss}
          className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-700"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
