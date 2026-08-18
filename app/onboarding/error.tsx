'use client'

import { useEffect } from 'react'
import { emitMetric } from '@/lib/metrics'

/**
 * Error boundary for the top-level onboarding surface.
 *
 * This is where a newly-invited member submits their answers, so an uncaught error
 * here previously blanked the screen at the single worst moment — mid-signup, with
 * no indication of whether their profile had been saved.
 *
 * The copy deliberately says the answers may already be saved and offers
 * Introductions as the forward path, because completeOnboarding writes the profile
 * BEFORE the client navigates: by the time anything can throw on the client, the
 * profile is very often already complete. Sending the member back into onboarding
 * blindly would be the wrong default.
 *
 * SCOPE: render/lifecycle failures beneath this route only. It does NOT catch the
 * onboarding SUBMIT handler — that is an event handler, outside every React boundary —
 * so components/OnboardingForm.tsx handles its own submit failures locally.
 *
 * PRIVACY: no stack trace and no error message rendered; the opaque digest is shown as
 * an incident reference.
 */
export default function OnboardingError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Browser-only; does NOT reach Vercel function logs.
    console.error('[onboarding/error] boundary caught', error)
    emitMetric('client_error_boundary', {
      surface: 'onboarding',
      errorClass: error?.name ?? 'Error',
      digest: error?.digest ?? 'none',
    })
  }, [error])

  return (
    <div className="min-h-screen bg-[#F5F6FB] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-slate-100 bg-white p-8 text-center shadow-sm">
        <h1 className="text-xl font-bold text-brand-navy tracking-tight">
          We hit a snag finishing your setup
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          Your answers may already have been saved. Try again, or go straight to your
          introductions — if your profile is complete, you’ll land there normally.
        </p>
        {/*
          Plain anchors, deliberately — NOT next/link. If the host browser is refusing the History
          API (the SecurityError class this page exists to catch), a client-side router navigation
          would fail for the same reason and strand the member here. A full page load always works,
          and neither link requires storage, cookies beyond the existing session, or JavaScript
          routing to be usable.
        */}
        <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="inline-flex w-full sm:w-auto items-center justify-center rounded-xl bg-brand-navy px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-navy-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold focus-visible:ring-offset-2"
          >
            Try again
          </button>
          <a href="/dashboard/introductions" className="inline-flex w-full sm:w-auto items-center justify-center rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:border-slate-300 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold focus-visible:ring-offset-2">
            Go to Introductions
          </a>
        </div>
        <p className="mt-4 text-xs text-slate-400">
          Still stuck? <a href="/login" className="font-semibold text-brand-navy underline underline-offset-2">Sign in again</a>
        </p>
        {error?.digest && (
          <p className="mt-5 text-[11px] text-slate-300">
            Reference: <span className="font-mono">{error.digest}</span>
          </p>
        )}
      </div>
    </div>
  )
}
