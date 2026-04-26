'use client'

import { useState } from 'react'
import { AlertCircle, MessageSquare, X, Loader2 } from 'lucide-react'
import { Button } from './ui/Button'

/**
 * ReportIssueButton
 *
 * Renders a "Report an issue" trigger that opens a modal containing a textarea.
 * On submit, POSTs to /api/issues/report with the user's text plus
 * page_url and user_agent (collected client-side).
 *
 * No props required. Drop-in usable from any client component.
 */
type Variant = 'report' | 'support'

const COPY: Record<Variant, { triggerLabel: string; icon: typeof AlertCircle; modalTitle: string; modalDescription: string; placeholder: string; successText: string }> = {
  report: {
    triggerLabel: 'Report an issue',
    icon: AlertCircle,
    modalTitle: 'Report an issue',
    modalDescription: 'Tell us what went wrong. The page URL and your browser info are included automatically.',
    placeholder: 'What happened? What did you expect?',
    successText: "We'll take a look as soon as we can.",
  },
  support: {
    triggerLabel: 'Message support',
    icon: MessageSquare,
    modalTitle: 'Message support',
    modalDescription: 'Have a question or need help? Send us a message and we\'ll get back to you.',
    placeholder: 'How can we help?',
    successText: "We'll respond as soon as we can.",
  },
}

export default function ReportIssueButton({ variant = 'report' }: { variant?: Variant } = {}) {
  const copy = COPY[variant]
  const TriggerIcon = copy.icon
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setText('')
    setError(null)
    setShowSuccess(false)
    setSubmitting(false)
  }

  const close = () => {
    setOpen(false)
    setTimeout(reset, 200)
  }

  const submit = async () => {
    const trimmed = text.trim()
    if (!trimmed) {
      setError(variant === 'support' ? 'Please describe what you need help with.' : 'Please describe the issue.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/issues/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_text: trimmed,
          page_url: typeof window !== 'undefined' ? window.location.href : null,
          user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data?.error || 'Something went wrong. Please try again.')
        setSubmitting(false)
        return
      }
      setShowSuccess(true)
      setSubmitting(false)
      setTimeout(close, 2500)
    } catch {
      setError('Network error. Please try again.')
      setSubmitting(false)
    }
  }

  return (
    <>
      <Button variant="secondary" size="md" onClick={() => setOpen(true)}>
        <TriggerIcon className="w-4 h-4 mr-2" />
        {copy.triggerLabel}
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-slate-900/40">
          <div
            className="absolute inset-0"
            onClick={close}
            aria-hidden="true"
          />
          <div className="relative w-full max-w-md bg-white rounded-2xl shadow-xl border border-slate-100 p-6">
            <button
              onClick={close}
              className="absolute top-3 right-3 text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-50"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>

            {showSuccess ? (
              <div className="text-center py-6">
                <div className="w-12 h-12 rounded-full bg-brand-gold-soft flex items-center justify-center mx-auto mb-3">
                  <AlertCircle className="w-5 h-5 text-brand-gold" />
                </div>
                <p className="text-base font-semibold text-slate-900 mb-1">Thanks — we received your message.</p>
                <p className="text-sm text-slate-500">{copy.successText}</p>
              </div>
            ) : (
              <>
                <h2 className="text-base font-semibold text-slate-900 mb-1">{copy.modalTitle}</h2>
                <p className="text-sm text-slate-500 mb-4 leading-relaxed">
                  {copy.modalDescription}
                </p>

                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={copy.placeholder}
                  rows={5}
                  disabled={submitting}
                  className="w-full text-sm text-slate-900 placeholder:text-slate-400 border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-brand-navy focus:border-transparent resize-none disabled:opacity-60"
                />

                {error && (
                  <p className="text-xs text-red-600 mt-2">{error}</p>
                )}

                <div className="mt-4 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                  <Button variant="ghost" size="md" onClick={close} disabled={submitting}>
                    Cancel
                  </Button>
                  <Button variant="primary" size="md" onClick={submit} disabled={submitting || !text.trim()}>
                    {submitting ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Submitting
                      </>
                    ) : (
                      variant === 'support' ? 'Send message' : 'Submit report'
                    )}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
