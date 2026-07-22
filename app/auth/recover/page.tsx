'use client'

import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { RecoveryFlow, RECOVERY_MESSAGES, parseRecoveryParamsFromLocation } from '@/lib/auth/recovery'
import { emitMetric } from '@/lib/metrics'
import { Loader2, ShieldCheck } from 'lucide-react'

// Run the scrub before the browser paints (earliest client execution). useLayoutEffect
// is a no-op on the server, so guard to avoid the SSR warning.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

/**
 * Intermediate recovery page. Prefetch-safe by construction: the initial GET verifies no
 * token — only the explicit "Continue password reset" click does. The recommended email
 * template carries the token in the URL FRAGMENT, which is never sent to the server, so the
 * token_hash appears in no server/CDN/middleware log. On mount we capture the token from the
 * fragment, then immediately scrub the address bar (removing fragment AND query) so it can't
 * leak via history, Referer, or analytics. The token is never rendered into HTML, never
 * logged, and never placed in a redirect or metric.
 */
function RecoverInner() {
  const router = useRouter()
  const flowRef = useRef<RecoveryFlow | null>(null)
  const [phase, setPhase] = useState<'checking' | 'ready' | 'verifying' | 'invalid' | 'error'>('checking')
  const [message, setMessage] = useState('')

  useIsomorphicLayoutEffect(() => {
    // 1) capture params (fragment preferred), 2) scrub the URL, 3) validate — NO verification.
    const params = parseRecoveryParamsFromLocation(window.location.hash, window.location.search)
    window.history.replaceState(null, '', window.location.pathname)

    const flow = new RecoveryFlow(createClient() as any, params)
    flowRef.current = flow
    const gate = flow.init()
    if (gate.state === 'ready') setPhase('ready')
    else { setPhase('invalid'); setMessage(RECOVERY_MESSAGES.invalid) }
  }, [])

  async function handleConfirm() {
    const flow = flowRef.current
    if (!flow) return
    setPhase('verifying')
    const result = await flow.confirm()
    if (result.ok) {
      emitMetric('recovery_verify_success')
      router.replace(result.redirect)
      return
    }
    emitMetric(
      result.kind === 'expired' ? 'recovery_verify_expired'
        : result.kind === 'used' ? 'recovery_verify_reused'
          : 'recovery_verify_invalid',
    )
    setPhase('error')
    setMessage(result.message)
  }

  return (
    <div className="min-h-screen flex">
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-brand-navy to-brand-navy-light flex-col justify-between p-12">
        <Link href="/" className="text-2xl font-bold text-white tracking-tight">Andrel</Link>
        <div className="space-y-6 text-white">
          <div className="space-y-3">
            <p className="text-2xl font-semibold leading-snug text-white">Curated introductions.</p>
            <p className="text-2xl font-semibold leading-snug text-white">Private opportunities.</p>
            <p className="text-2xl font-semibold leading-snug text-brand-gold">No feeds, no cold outreach.</p>
          </div>
          <div className="h-px w-12 bg-white/20" />
          <div>
            <p className="text-lg font-medium mb-1.5 text-white">Confirm your password reset.</p>
            <p className="text-sm text-white/60">One click keeps your reset link secure from email scanners.</p>
          </div>
        </div>
        <p className="text-white/40 text-sm">© {new Date().getFullYear()} Andrel</p>
      </div>

      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8">
            <Link href="/" className="text-xl font-bold text-brand-navy lg:hidden block mb-6 tracking-tight">Andrel</Link>
            <h2 className="text-2xl font-bold text-slate-900">Confirm password reset</h2>
          </div>

          {phase === 'checking' && (
            <div className="flex items-center gap-3 text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" /> Preparing…
            </div>
          )}

          {phase === 'ready' && (
            <div className="space-y-5">
              <div className="flex items-start gap-3 bg-slate-50 border border-slate-200 text-slate-600 text-sm px-4 py-4 rounded-lg leading-relaxed">
                <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-brand-navy" />
                <span>For your security, click below to continue. Your reset link is verified only when you choose to proceed.</span>
              </div>
              <button
                onClick={handleConfirm}
                className="w-full flex items-center justify-center gap-2 bg-brand-navy text-white text-sm font-semibold px-4 py-2.5 rounded-xl hover:bg-brand-navy-dark transition-colors"
              >
                Continue password reset
              </button>
            </div>
          )}

          {phase === 'verifying' && (
            <div className="flex items-center gap-3 text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" /> Verifying your link…
            </div>
          )}

          {(phase === 'invalid' || phase === 'error') && (
            <div className="space-y-4">
              <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-4 rounded-lg leading-relaxed">
                {message}
              </div>
              <Link href="/auth/forgot-password" className="inline-block text-sm font-semibold text-brand-navy hover:underline">
                Request a new reset email
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function RecoverPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-[#F5F6FB]">
        <p className="text-slate-500 text-sm">Preparing…</p>
      </div>
    }>
      <RecoverInner />
    </Suspense>
  )
}
