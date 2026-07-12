'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { LifeBuoy, X, Compass, BookOpen } from 'lucide-react'
import ReportIssueButton from './ReportIssueButton'
import { OPEN_TUTORIAL_EVENT } from './Tutorial'

/**
 * Floating Help hub. One instance is rendered in the dashboard layout, so it
 * appears on every authenticated dashboard page.
 *
 * Reuse, not duplication:
 *  - "Guided Tour" dispatches the existing OPEN_TUTORIAL_EVENT (same replay
 *    mechanism as Settings → View tutorial). No tutorial state/copy is duplicated.
 *  - "Contact Support" / "Send Feedback" render the existing ReportIssueButton
 *    (support/report variants), which POST to /api/issues/report — the exact
 *    same route, storage (issue_reports), admin notification, and modal used in
 *    Settings. No second support system is created.
 *  - "Help Center" links to the existing /faq page.
 *
 * Open state is intentionally NOT persisted — the hub is available every visit.
 */
export default function FloatingHelp() {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const firstActionRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)

  const close = useCallback(() => setOpen(false), [])

  // Outside-click + Escape close, and move focus into the panel on open.
  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    firstActionRef.current?.focus()
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // Return focus to the trigger when the panel closes.
  useEffect(() => {
    if (wasOpen.current && !open) buttonRef.current?.focus()
    wasOpen.current = open
  }, [open])

  const openTour = () => {
    setOpen(false)
    window.dispatchEvent(new CustomEvent(OPEN_TUTORIAL_EVENT))
  }

  return (
    <div
      ref={containerRef}
      className="fixed right-4 z-40 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] md:right-6 md:bottom-6"
    >
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Need help?"
          className="absolute bottom-full right-0 mb-3 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-slate-100 bg-[#FAF6EE] px-4 py-3">
            <p className="text-sm font-bold text-brand-navy">Need help?</p>
            <button
              type="button"
              onClick={close}
              aria-label="Close help"
              className="rounded-full p-1 text-slate-400 transition-colors hover:bg-white hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="p-1.5">
            {/* Guided Tour — reuses the existing tutorial replay event */}
            <button
              ref={firstActionRef}
              type="button"
              onClick={openTour}
              className="flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-slate-50"
            >
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-gold-soft text-brand-gold">
                <Compass className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-slate-900">Guided Tour</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">
                  Learn how introductions, messages, meetings, opportunities, and other features work.
                </span>
              </span>
            </button>

            {/* Contact Support — reuses the existing support flow */}
            <ReportIssueButton
              variant="support"
              triggerVariant="row"
              label="Contact Support"
              description="Send a question or request to the Andrel team."
            />

            {/* Send Feedback — reuses the existing report flow */}
            <ReportIssueButton
              variant="report"
              triggerVariant="row"
              label="Send Feedback"
              description="Share an idea, report a problem, or suggest an improvement."
            />

            {/* Help Center — links to the existing FAQ */}
            <a
              href="/faq"
              target="_blank"
              rel="noopener noreferrer"
              onClick={close}
              className="flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 transition-colors hover:bg-slate-50"
            >
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                <BookOpen className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-slate-900">Help Center</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">
                  Browse answers to common questions.
                </span>
              </span>
            </a>
          </div>
        </div>
      )}

      {/* Trigger */}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Help"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Help"
        className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-navy text-white shadow-lg ring-1 ring-brand-gold/25 transition-colors hover:bg-brand-navy-dark"
      >
        <LifeBuoy className="h-5 w-5" aria-hidden="true" />
      </button>
    </div>
  )
}
