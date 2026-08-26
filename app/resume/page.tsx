'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { safeReplaceState } from '@/lib/browser/safeApis'
import { RESUME_GENERIC_RESPONSE } from '@/lib/invitations/resumeMessages'
import { Loader2, ShieldCheck } from 'lucide-react'
import { PUBLIC_LOGO_HREF, LOGO_ARIA_LABEL } from '@/lib/nav/logoHref'

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

/**
 * Resume landing page.
 *
 * The token arrives in the URL FRAGMENT, so it never reaches a server, a CDN, a middleware log or a
 * Referer header. On mount we capture it into memory and immediately scrub the address bar, so it
 * cannot leak through history or analytics either.
 *
 * NOTHING HAPPENS ON LOAD. Rendering this page sends no email, mints no link and changes no state —
 * only the explicit button press does, via POST. That is what makes the page safe to put in an
 * email at all: scanners, corporate mail security and chat previewers all fetch links, and a page
 * that acted on load would send unrequested mail on the recipient's behalf and burn their rate
 * limit before they ever saw it.
 *
 * The token is never rendered into the DOM, never logged, and never placed in a metric.
 */
export default function ResumePage() {
  const tokenRef = useRef<string | null>(null)
  const [phase, setPhase] = useState<'checking' | 'ready' | 'sending' | 'done' | 'invalid' | 'error'>('checking')
  const [scrubFailed, setScrubFailed] = useState(false)

  useIsomorphicLayoutEffect(() => {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
    const token = new URLSearchParams(hash).get('token')
    tokenRef.current = token

    // Embedded browsers (iOS WKWebView, the LinkedIn in-app browser) can refuse the History API
    // with a SecurityError. safeReplaceState degrades instead of throwing — an unguarded throw here
    // would escape to the global error boundary and blank the screen, which is one of the exact
    // failures this work exists to end. The token is already captured above, so a refused scrub
    // only means the fragment stays visible in the address bar; it is still never sent anywhere.
    const scrubbed = safeReplaceState(window.location.pathname, 'resume')
    if (scrubbed === false) setScrubFailed(true)

    setPhase(token ? 'ready' : 'invalid')
  }, [])

  async function handleContinue() {
    if (phase === 'sending') return           // re-entrancy guard
    setPhase('sending')
    try {
      const res = await fetch('/api/onboarding/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenRef.current }),
      })
      // A 503 is the only distinguishable outcome, and it says nothing about any account — it means
      // the service itself could not answer, and retrying is reasonable.
      setPhase(res.status === 503 ? 'error' : 'done')
    } catch {
      setPhase('error')
    }
  }

  return (
    <div className="min-h-screen bg-[#F5F6FB] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-slate-100 p-8 space-y-5">
        <Link
          href={PUBLIC_LOGO_HREF}
          aria-label={LOGO_ARIA_LABEL}
          className="flex items-center gap-2 text-[#1B2850] w-fit rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1B2850] focus-visible:ring-offset-2"
        >
          <ShieldCheck className="w-5 h-5" aria-hidden />
          <span className="text-sm font-semibold">Andrel</span>
        </Link>

        {phase === 'checking' && (
          <div className="flex justify-center py-6"><Loader2 className="w-6 h-6 text-slate-400 animate-spin" /></div>
        )}

        {phase === 'ready' && (
          <>
            <h1 className="text-xl font-bold text-slate-900">Continue setting up your profile</h1>
            <p className="text-sm text-slate-600">
              Press the button below and we&rsquo;ll email a fresh, secure sign-in link to the address your
              invitation was sent to. Nothing is sent until you press it.
            </p>
            <button
              onClick={handleContinue}
              className="w-full bg-[#1B2850] text-white font-semibold rounded-lg py-3 hover:opacity-90"
            >
              Continue setting up
            </button>
            {scrubFailed && (
              <p className="text-xs text-slate-500">
                If this page behaves oddly, open it in Safari or Chrome rather than an in-app browser.
              </p>
            )}
          </>
        )}

        {phase === 'sending' && (
          <div className="flex justify-center py-6"><Loader2 className="w-6 h-6 text-slate-400 animate-spin" /></div>
        )}

        {/* Success and every failure render the SAME text. The page is not an account oracle. */}
        {phase === 'done' && (
          <>
            <h1 className="text-xl font-bold text-slate-900">Check your email</h1>
            <p className="text-sm text-slate-600">{RESUME_GENERIC_RESPONSE}</p>
            <p className="text-xs text-slate-500">
              The link in that email is time-limited. If it expires, you can open this page again from your
              reminder email and press the button once more.
            </p>
          </>
        )}

        {phase === 'invalid' && (
          <>
            <h1 className="text-xl font-bold text-slate-900">This link isn&rsquo;t available</h1>
            <p className="text-sm text-slate-600">
              This invitation link can&rsquo;t be used. If you already have an Andrel account, sign in below.
            </p>
            <Link href="/login" className="text-sm font-semibold text-[#1B2850] hover:underline">Sign in</Link>
          </>
        )}

        {phase === 'error' && (
          <>
            <h1 className="text-xl font-bold text-slate-900">Temporarily unavailable</h1>
            <p className="text-sm text-slate-600">Something went wrong on our side. Please try again in a moment.</p>
            <button onClick={() => setPhase('ready')} className="text-sm font-semibold text-[#1B2850] hover:underline">
              Try again
            </button>
          </>
        )}
      </div>
    </div>
  )
}
