'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Sparkles, Users, Network, MessageCircle, CalendarDays,
  BriefcaseBusiness, ConciergeBell, UserCircle, Rocket,
  X, ChevronLeft, ChevronRight,
  type LucideIcon,
} from 'lucide-react'

// Preserve the original WelcomeModal key so members who already dismissed the
// first-run experience are NOT forced through the new tutorial. New members
// (no key) see it once; dismissal (X / Skip / Start exploring) sets the key.
const STORAGE_KEY = 'andrel_welcome_modal_dismissed_v1'

// Manual replay (Settings → View tutorial) dispatches this window event. It
// opens the tutorial at step 1 without reading or writing the storage key, so
// replaying never changes normal first-run dismissal state.
export const OPEN_TUTORIAL_EVENT = 'andrel:open-tutorial'

interface Step {
  icon: LucideIcon
  headline: string
  body: string
}

const STEPS: Step[] = [
  {
    icon: Sparkles,
    headline: 'Welcome to Andrel',
    body: 'Andrel is a curated professional network built around thoughtful introductions, trusted relationships, and meaningful opportunities.',
  },
  {
    icon: Users,
    headline: 'Introductions',
    body: 'Review people Andrel believes may be valuable for you to meet. Express interest or pass — an introduction is created when interest is mutual.',
  },
  {
    icon: Network,
    headline: 'Your Network',
    body: 'See your active connections and return to the people you have met through Andrel.',
  },
  {
    icon: MessageCircle,
    headline: 'Messages',
    body: 'Once an introduction is active, continue the conversation directly inside Andrel.',
  },
  {
    icon: CalendarDays,
    headline: 'Meetings',
    body: 'Propose, schedule, and manage conversations with members of your network.',
  },
  {
    icon: BriefcaseBusiness,
    headline: 'Opportunities',
    body: 'Discover or share private hiring, partnership, business, and expertise needs.',
  },
  {
    icon: ConciergeBell,
    headline: 'Concierge',
    body: 'Looking for someone specific? Send a request and Andrel will help identify potential introductions.',
  },
  {
    icon: UserCircle,
    headline: 'Profile & Preferences',
    body: 'A complete profile and clear preferences help Andrel make stronger, more relevant introductions.',
  },
  {
    icon: Rocket,
    headline: 'You’re ready',
    body: 'Start with Introductions and explore at your own pace. If you have questions or a specific request, message Daniel anytime.',
  },
]

export default function Tutorial() {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)

  const total = STEPS.length
  const isFirst = step === 0
  const isLast = step === total - 1

  // First dashboard entry: open once if never dismissed.
  useEffect(() => {
    try {
      if (!localStorage.getItem(STORAGE_KEY)) {
        setStep(0)
        setOpen(true)
      }
    } catch {
      /* localStorage unavailable (private mode) — skip auto-open */
    }
  }, [])

  // Manual replay from Settings — open at step 1, never touch the storage key.
  useEffect(() => {
    const handler = () => {
      setStep(0)
      setOpen(true)
    }
    window.addEventListener(OPEN_TUTORIAL_EVENT, handler)
    return () => window.removeEventListener(OPEN_TUTORIAL_EVENT, handler)
  }, [])

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, '1')
    } catch {
      /* best-effort persistence */
    }
    setOpen(false)
  }, [])

  const next = useCallback(() => {
    setStep((s) => (s >= total - 1 ? s : s + 1))
  }, [total])

  const back = useCallback(() => {
    setStep((s) => (s <= 0 ? s : s - 1))
  }, [])

  // Focus management, focus trap, Escape-to-close, and background scroll lock.
  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    const previouslyFocused = document.activeElement as HTMLElement | null
    document.body.style.overflow = 'hidden'

    const focusables = () =>
      dialog
        ? Array.from(
            dialog.querySelectorAll<HTMLElement>(
              'button, [href], input, [tabindex]:not([tabindex="-1"])'
            )
          ).filter((el) => !el.hasAttribute('disabled'))
        : []

    ;(focusables()[0] ?? dialog)?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        dismiss()
        return
      }
      if (e.key === 'Tab') {
        const items = focusables()
        if (items.length === 0) return
        const first = items[0]
        const last = items[items.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = ''
      previouslyFocused?.focus?.()
    }
  }, [open, dismiss])

  if (!open) return null

  const current = STEPS[step]
  const Icon = current.icon
  const headlineId = 'tutorial-headline'
  const bodyId = 'tutorial-body'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <style>{`@keyframes andrelTutFade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`}</style>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headlineId}
        aria-describedby={bodyId}
        tabIndex={-1}
        className="relative w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl outline-none"
      >
        {/* Close */}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Close tutorial"
          className="absolute right-3 top-3 z-10 rounded-full p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Warm ivory icon banner */}
        <div className="flex justify-center bg-[#FAF6EE] px-8 pb-6 pt-10">
          <div
            key={`icon-${step}`}
            style={{ animation: 'andrelTutFade 220ms ease-out' }}
            className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-gold-soft text-brand-gold ring-1 ring-brand-gold/20"
          >
            <Icon className="h-8 w-8" aria-hidden="true" />
          </div>
        </div>

        {/* Content */}
        <div className="px-8 pb-7 pt-6 text-center">
          <div key={`content-${step}`} style={{ animation: 'andrelTutFade 220ms ease-out' }}>
            <h2 id={headlineId} className="text-xl font-bold tracking-tight text-brand-navy">
              {current.headline}
            </h2>
            <p id={bodyId} className="mt-2.5 text-sm leading-relaxed text-slate-600">
              {current.body}
            </p>
          </div>

          {/* Progress */}
          <div className="mt-6 flex items-center justify-center gap-1.5" aria-hidden="true">
            {STEPS.map((_, i) => (
              <span
                key={i}
                className={
                  'h-1.5 rounded-full transition-all duration-300 ' +
                  (i === step
                    ? 'w-5 bg-brand-gold'
                    : i < step
                    ? 'w-1.5 bg-brand-navy/40'
                    : 'w-1.5 bg-slate-200')
                }
              />
            ))}
          </div>
          <p className="mt-2 text-xs font-medium text-slate-400" aria-live="polite">
            {step + 1} of {total}
          </p>

          {/* Controls */}
          <div className="mt-6 flex items-center gap-3">
            {!isFirst && (
              <button
                type="button"
                onClick={back}
                aria-label="Previous step"
                className="inline-flex items-center gap-1 rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-100"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Back
              </button>
            )}
            <button
              type="button"
              onClick={isLast ? dismiss : next}
              aria-label={isLast ? 'Start exploring' : 'Next step'}
              className="ml-auto inline-flex items-center gap-1.5 rounded-xl bg-brand-navy px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-navy-dark"
            >
              {isLast ? 'Start exploring' : 'Next'}
              {!isLast && <ChevronRight className="h-4 w-4" aria-hidden="true" />}
            </button>
          </div>

          {/* Skip */}
          {!isLast && (
            <button
              type="button"
              onClick={dismiss}
              className="mt-4 text-xs font-medium text-slate-400 underline-offset-2 transition-colors hover:text-slate-600 hover:underline"
            >
              Skip tutorial
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
