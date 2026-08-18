'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { RefreshCw } from 'lucide-react'
import { emitMetric } from '@/lib/metrics'

/**
 * Route-level error boundary for every /dashboard segment.
 *
 * WHAT THIS CATCHES: errors thrown while RENDERING this segment's tree, and in its
 * components' lifecycle. That is a real and worthwhile improvement — before this, the
 * app had no boundary at all, so a render failure unmounted everything and Next's
 * fallback showed "Application error: a client-side exception has occurred" on a blank
 * page, which is what two newly-onboarded members hit on their first dashboard view.
 *
 * WHAT THIS DOES NOT CATCH — do not read this file as total client-error containment:
 *   - exceptions thrown in event handlers (onClick, onSubmit, …);
 *   - exceptions thrown from setTimeout / setInterval callbacks;
 *   - arbitrary rejected promises and unhandled rejections;
 *   - WebSocket / Supabase-realtime subscription callbacks;
 *   - errors thrown by THIS component itself (see app/global-error.tsx);
 *   - many navigation and stale-chunk failures.
 * Those paths must handle their own failures locally; several were hardened alongside
 * this boundary (the countdown tick, the onboarding submit, the realtime callback).
 *
 * PRIVACY: renders NO stack trace and NO error message — an error string can carry row
 * data or internals. Next's `digest` IS shown, deliberately: it is an opaque,
 * non-reversible correlation id with no member data in it, and quoting it is the only
 * way a member can help us find their incident.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Local console only — this runs in the MEMBER'S BROWSER, so it does NOT reach Vercel
    // function logs. Useful for development and for a member who opens devtools; it is not
    // the diagnostic channel.
    console.error('[dashboard/error] boundary caught', error)
    // The beacon IS the channel that reaches server logs, via the existing hardened
    // /api/metrics facility (allowlisted name, sanitized coarse dimensions, same-origin,
    // rate-limited, log-only). Never throws — emitMetric swallows its own failures — so
    // instrumentation can never make this boundary itself fail.
    emitMetric('client_error_boundary', {
      surface: 'dashboard',
      errorClass: error?.name ?? 'Error',
      digest: error?.digest ?? 'none',
    })
  }, [error])

  return (
    <div className="min-h-screen bg-[#FAF6EE] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-slate-100 bg-white p-8 text-center shadow-sm">
        <h1 className="text-xl font-bold text-brand-navy tracking-tight">
          We couldn’t load this page
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          Something went wrong on our side. Your account and profile are safe — nothing you
          entered was lost.
        </p>
        <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="inline-flex w-full sm:w-auto items-center justify-center gap-2 rounded-xl bg-brand-navy px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-navy-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold focus-visible:ring-offset-2"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Try again
          </button>
          <Link
            href="/dashboard/introductions"
            className="inline-flex w-full sm:w-auto items-center justify-center rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:border-slate-300 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold focus-visible:ring-offset-2"
          >
            Go to Introductions
          </Link>
        </div>
        <p className="mt-6 text-xs text-slate-400">
          If this keeps happening, message Daniel and we’ll sort it out.
        </p>
        {error?.digest && (
          <p className="mt-2 text-[11px] text-slate-300">
            Reference: <span className="font-mono">{error.digest}</span>
          </p>
        )}
      </div>
    </div>
  )
}
