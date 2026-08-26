'use client'

import { useState, useTransition } from 'react'
import { Sparkles, X } from 'lucide-react'
import { GUIDANCE_COPY, actionableAnnouncement } from '@/lib/introductions/guidance'
import { dismissFirstIntroductionsExplainer } from '@/app/actions'

/**
 * "Your introductions are ready" — the one-time, richer explainer.
 *
 * SHOWN ONCE, TO NEW MEMBERS ONLY, AND ONLY WITH REAL CARDS ON SCREEN. The server decides:
 * profiles.intro_guidance_enrolled_at must be set (migration 084 stamps it going forward and
 * backfills nobody, so no historical member can qualify), the dismissal stamp must be absent, and
 * the actionable count must be greater than zero. It therefore cannot appear during onboarding or
 * on an empty Introductions page.
 *
 * DISMISSAL IS SERVER-SIDE — a self-scoped server action writing the member's own profile row. Not
 * localStorage: a preference that vanishes on a new device is not a dismissal, it is a coin flip.
 * The optimistic local hide is only so the panel closes instantly; the durable fact is the write.
 *
 * It REPLACES the compact reminder while it shows (never stacks with it) because it already says
 * everything the reminder says, in more words. Exactly one guidance panel is ever on screen.
 *
 * Reveals nothing about the counterparty: its only inputs are the viewer's own count and stamps.
 */
export default function FirstIntroductionsExplainer({ count }: { count: number }) {
  const [hidden, setHidden] = useState(false)
  const [pending, startTransition] = useTransition()
  const safe = Math.max(0, count | 0)

  if (hidden || safe <= 0) return null

  const dismiss = () => {
    setHidden(true) // optimistic; the durable write follows
    startTransition(async () => {
      try {
        await dismissFirstIntroductionsExplainer()
      } catch {
        // A failed write means it reappears next visit — the honest outcome, and strictly better
        // than pretending a preference was saved. Nothing else on the page depends on it.
      }
    })
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-6 rounded-xl border border-brand-navy/12 bg-white px-4 py-4 sm:px-5"
    >
      <p className="sr-only">{actionableAnnouncement(safe)}</p>
      <div className="flex items-start gap-3 sm:gap-4 min-w-0">
        <span className="w-9 h-9 rounded-lg bg-brand-navy/[0.04] text-brand-gold flex items-center justify-center flex-shrink-0">
          <Sparkles className="w-[18px] h-[18px]" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-brand-navy tracking-tight leading-tight break-words">
            {GUIDANCE_COPY.firstBatch.heading}
          </h2>
          <p className="mt-1.5 text-sm text-slate-600 leading-relaxed break-words">
            {GUIDANCE_COPY.firstBatch.body}
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          disabled={pending}
          aria-label="Dismiss this explanation"
          className="flex-shrink-0 -mr-1 -mt-1 w-9 h-9 inline-flex items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-50 hover:text-brand-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy focus-visible:ring-offset-2 disabled:opacity-50"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
