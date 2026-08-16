'use client'

import { useEffect, useRef, useState } from 'react'
import { CalendarClock, Sparkles } from 'lucide-react'
import { countdownState, formatCountdown } from '@/lib/introductions/thursdaySchedule'
import type { ThursdayBannerKind } from '@/lib/introductions/thursdayBanner'

export interface ThursdayCountdownBannerProps {
  kind: ThursdayBannerKind
  title: string
  subtitle: string | null
  targetIso: string
  showCountdown: boolean
  /** Server-computed initial text — rendered identically on the server and first client render. */
  initialCountdownText: string
}

const ACCENT: Record<ThursdayBannerKind, { ring: string; iconWrap: string; Icon: typeof CalendarClock }> = {
  before:         { ring: 'border-brand-gold/30',  iconWrap: 'bg-brand-gold-soft text-brand-gold', Icon: CalendarClock },
  after_received: { ring: 'border-emerald-200',    iconWrap: 'bg-emerald-50 text-emerald-600',     Icon: Sparkles },
}

/**
 * Live weekly-introduction countdown. Computes the remaining time entirely on the client from the
 * absolute `targetIso` — it NEVER polls the database. The timer pauses while the tab is hidden and
 * recomputes immediately on return, so a backgrounded tab neither drifts nor burns cycles. The
 * first render uses the server-provided `initialCountdownText` (no hydration mismatch); a mount
 * effect then drives the live updates. Time is always clamped ≥ 0 via countdownState.
 */
export default function ThursdayCountdownBanner({
  kind, title, subtitle, targetIso, showCountdown, initialCountdownText,
}: ThursdayCountdownBannerProps) {
  const [text, setText] = useState(initialCountdownText)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!showCountdown) return
    const target = new Date(targetIso)

    const tick = () => setText(formatCountdown(countdownState(new Date(), target)))

    const start = () => {
      if (intervalRef.current != null) return
      tick() // immediate refresh so we never show a stale value
      intervalRef.current = setInterval(tick, 1000)
    }
    const stop = () => {
      if (intervalRef.current != null) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop()
      else start()
    }

    // Only run the clock when the tab is actually visible.
    if (document.visibilityState !== 'hidden') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [targetIso, showCountdown])

  const accent = ACCENT[kind]
  const Icon = accent.Icon

  return (
    <div
      role="status"
      className={`mb-4 flex items-start gap-3 rounded-2xl border ${accent.ring} bg-white px-4 py-3.5 sm:px-5 sm:py-4 shadow-sm`}
    >
      <span
        aria-hidden="true"
        className={`flex-shrink-0 mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-full ${accent.iconWrap}`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-brand-navy leading-snug">{title}</p>
        {subtitle && <p className="mt-0.5 text-xs sm:text-[13px] text-slate-500 leading-snug">{subtitle}</p>}
        {showCountdown && (
          <p className="mt-1.5 text-xs sm:text-[13px] font-medium text-brand-gold tabular-nums">
            {/* sr-only prefix gives the number context for assistive tech; visible text is the same fact. */}
            <span className="sr-only">Time until the next introduction batch: </span>
            {text}
          </p>
        )}
      </div>
    </div>
  )
}
