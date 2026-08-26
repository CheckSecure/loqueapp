'use client'

import { useCallback } from 'react'
import { ArrowDown } from 'lucide-react'
import { GUIDANCE_COPY, actionableAnnouncement } from '@/lib/introductions/guidance'

/**
 * "You have introductions waiting" — the compact contextual reminder.
 *
 * SHOWN ONLY while the member personally has at least one actionable introduction ON SCREEN. The
 * count is passed in from the same array that renders the cards, so the banner cannot say two are
 * waiting above one clickable card. It is not dismissible while cards remain, and it disappears the
 * instant the count reaches zero — because at that point the server renders a different state
 * entirely rather than this component with count 0.
 *
 * WHAT IT DOES NOT CLAIM. Responding restores ELIGIBILITY for consideration. It does not produce an
 * introduction: candidate fit, both members' capacity, the pair cooldown, prior-intro history,
 * blocking and pool availability all still decide. No "must", no "unlock", no guarantee.
 *
 * PRIVACY. Its only input is a number the viewer could count themselves. It carries no counterparty
 * state and can never reveal whether anyone has expressed interest or who is waiting on whom.
 *
 * CLIENT COMPONENT for exactly one reason: the action moves keyboard focus to the first actionable
 * card. It is a real <button>, reachable by keyboard, with a visible focus ring; it navigates
 * nowhere and mutates nothing.
 *
 * NOT FIXED, NOT STICKY — normal flow directly above the grid, so it can never cover the fixed
 * MobileNav or the Thursday countdown above it.
 */
export default function RespondToIntroductionsNotice({
  count,
  targetId = 'first-actionable-introduction',
}: {
  count: number
  targetId?: string
}) {
  const focusFirstCard = useCallback(() => {
    const el = document.getElementById(targetId)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // The card is not natively focusable, so make it programmatically focusable for this move and
    // release it again — leaving a permanent tabindex would insert a phantom tab stop.
    const hadTabIndex = el.hasAttribute('tabindex')
    if (!hadTabIndex) el.setAttribute('tabindex', '-1')
    el.focus({ preventScroll: true })
    if (!hadTabIndex) {
      const release = () => { el.removeAttribute('tabindex'); el.removeEventListener('blur', release) }
      el.addEventListener('blur', release)
    }
  }, [targetId])

  const safe = Math.max(0, count | 0)
  if (safe <= 0) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-6 rounded-xl border border-brand-gold/25 bg-brand-gold/[0.06] px-4 py-3"
    >
      {/* The count reaches assistive technology as a sentence, not as a bare numeral in a pill. */}
      <p className="sr-only">{actionableAnnouncement(safe)}</p>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 min-w-0">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-brand-navy leading-snug break-words" aria-hidden="true">
            {GUIDANCE_COPY.reminder.heading}
            <span className="ml-1.5 font-normal text-slate-500">
              {safe === 1 ? '1 awaiting your response' : `${safe} awaiting your response`}
            </span>
          </p>
          <p className="mt-1 text-xs text-slate-600 leading-relaxed break-words">
            {GUIDANCE_COPY.reminder.body}
          </p>
        </div>
        <button
          type="button"
          onClick={focusFirstCard}
          className="inline-flex items-center justify-center gap-1.5 flex-shrink-0 min-h-[2.5rem] rounded-lg border border-brand-navy/15 bg-white px-3.5 py-2 text-xs font-semibold text-brand-navy transition-colors hover:border-brand-gold hover:text-brand-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy focus-visible:ring-offset-2"
        >
          {GUIDANCE_COPY.reminder.actionLabel}
          <ArrowDown className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
