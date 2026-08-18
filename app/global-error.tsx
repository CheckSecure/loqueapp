'use client'

import { useEffect } from 'react'
import { emitMetric } from '@/lib/metrics'

/**
 * Last-resort RENDER boundary. Catches errors thrown while rendering the ROOT layout
 * itself — the one place a segment-level error.tsx cannot reach — and replaces Next's
 * blank "Application error: a client-side exception has occurred" screen with something
 * a member can act on.
 *
 * SCOPE, stated honestly: like every React boundary this covers render and lifecycle
 * failures only. Event handlers, timers, unhandled promise rejections, realtime
 * callbacks, and stale-chunk/navigation failures are NOT covered here and must be
 * handled where they occur.
 *
 * Must render its own <html>/<body>: when this renders, the root layout did not.
 * Deliberately dependency-free on screen (no fonts, no icons, inline styles) so it
 * cannot itself fail for the same reason the layout did — emitMetric is import-safe and
 * non-throwing.
 *
 * PRIVACY: no stack trace and no error message on screen. The opaque digest is shown as
 * an incident reference; it carries no member data.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Browser-only; does NOT reach Vercel function logs.
    console.error('[global-error] boundary caught', error)
    // The beacon is what reaches server logs (existing hardened /api/metrics facility).
    emitMetric('client_error_boundary', {
      surface: 'global',
      errorClass: error?.name ?? 'Error',
      digest: error?.digest ?? 'none',
    })
  }, [error])

  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#FAF6EE', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div style={{ maxWidth: 420, width: '100%', background: '#fff', borderRadius: 16, border: '1px solid #e2e8f0', padding: 32, textAlign: 'center' }}>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1B2850', letterSpacing: '-0.01em' }}>
              Something went wrong
            </h1>
            <p style={{ marginTop: 12, fontSize: 14, lineHeight: 1.6, color: '#475569' }}>
              We hit an unexpected problem loading Andrel. Your account and anything you entered are safe.
            </p>
            <div style={{ marginTop: 24, display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={reset}
                style={{ background: '#1B2850', color: '#fff', border: 0, borderRadius: 12, padding: '10px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
              >
                Try again
              </button>
              {/* Plain anchors only: a client router navigation would depend on the History API,
                  which is exactly what an embedded browser may be refusing. */}
              <a
                href="/dashboard/introductions"
                style={{ background: '#fff', color: '#334155', border: '1px solid #e2e8f0', borderRadius: 12, padding: '10px 20px', fontSize: 14, fontWeight: 600, textDecoration: 'none' }}
              >
                Go to Introductions
              </a>
              <a
                href="/login"
                style={{ background: '#fff', color: '#334155', border: '1px solid #e2e8f0', borderRadius: 12, padding: '10px 20px', fontSize: 14, fontWeight: 600, textDecoration: 'none' }}
              >
                Sign in again
              </a>
            </div>
            {error?.digest && (
              <p style={{ marginTop: 16, fontSize: 11, color: '#cbd5e1', fontFamily: 'ui-monospace, monospace' }}>
                Reference: {error.digest}
              </p>
            )}
          </div>
        </div>
      </body>
    </html>
  )
}
