'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { emitMetric } from '@/lib/metrics'
import { normalizeEmail } from '@/lib/auth/normalizeEmail'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

type Phase = 'compose' | 'submitting' | 'sent'

const RESEND_COOLDOWN_SECONDS = 60

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [normalizedEmail, setNormalizedEmail] = useState('')
  const [phase, setPhase] = useState<Phase>('compose')
  const [error, setError] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)

  // Accessible countdown tick.
  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  // Request a reset for `target`. The server route normalizes + resolves the canonical
  // auth email and always returns a generic response, so we can never enumerate accounts.
  async function requestReset(target: string) {
    setError(null)
    setPhase('submitting')
    const normalized = normalizeEmail(target)
    setNormalizedEmail(normalized)
    try {
      const res = await fetch('/api/auth/request-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalized }),
      })
      const data = await res.json().catch(() => ({}))
      // Only a genuine server fault (ok:false / non-200) is surfaced — never account existence.
      if (!res.ok || data?.ok === false) {
        setError('Something went wrong. Please try again in a moment.')
        setPhase('compose')
        return
      }
      emitMetric('recovery_email_requested')
      setPhase('sent')
      setCooldown(RESEND_COOLDOWN_SECONDS)
    } catch {
      setError('Something went wrong. Please try again in a moment.')
      setPhase('compose')
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    requestReset(email)
  }

  return (
    <div className="min-h-screen flex">
      {/* Left panel */}
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
            <p className="text-lg font-medium mb-1.5 text-white">Recover your account.</p>
            <p className="text-sm text-white/60">Enter your email and we'll send reset instructions.</p>
          </div>
        </div>
        <p className="text-white/40 text-sm">© {new Date().getFullYear()} Andrel</p>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8">
            <Link href="/" className="text-xl font-bold text-brand-navy lg:hidden block mb-6 tracking-tight">Andrel</Link>
            <h2 className="text-2xl font-bold text-slate-900">Forgot password?</h2>
            <p className="mt-1 text-sm text-slate-500">
              Remembered it?{' '}
              <Link href="/login" className="text-brand-navy font-semibold hover:underline">Sign in</Link>
            </p>
          </div>

          {phase === 'sent' ? (
            <div className="space-y-4" aria-live="polite">
              <div className="bg-green-50 border border-green-200 text-green-800 text-sm px-4 py-4 rounded-lg leading-relaxed">
                If an account exists for that email, we&apos;ll send you a password-reset link shortly.
                <div className="mt-2 text-green-900">
                  Sent to <span className="font-semibold break-all">{normalizedEmail}</span>
                </div>
                <div className="mt-2 text-green-800/90">Check your spam or junk folder if it doesn&apos;t arrive within a few minutes.</div>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => cooldown === 0 && requestReset(normalizedEmail)}
                  disabled={cooldown > 0}
                  aria-disabled={cooldown > 0}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-2 border border-slate-300 text-slate-700 text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors',
                    cooldown > 0 ? 'opacity-60 cursor-not-allowed' : 'hover:bg-slate-50',
                  )}
                >
                  {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend link'}
                </button>
                <button
                  type="button"
                  onClick={() => { setPhase('compose'); setError(null) }}
                  className="flex-1 text-sm font-semibold text-brand-navy hover:underline px-2 py-2.5"
                >
                  Use a different email
                </button>
              </div>

              <p className="text-xs text-slate-400">
                Still stuck? Email{' '}
                <a href="mailto:hello@andrel.app" className="text-brand-navy font-medium hover:underline">hello@andrel.app</a>{' '}
                and we&apos;ll help you back in.
              </p>
              <div>
                <Link href="/login" className="text-brand-navy font-semibold hover:underline text-sm">Back to sign in</Link>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg" role="alert">
                  {error}
                </div>
              )}
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1.5">
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-gold focus:border-transparent transition"
                  placeholder="you@example.com"
                />
              </div>
              <button
                type="submit"
                disabled={phase === 'submitting'}
                className={cn(
                  'w-full flex items-center justify-center gap-2 bg-brand-navy text-white text-sm font-semibold px-4 py-2.5 rounded-xl hover:bg-brand-navy-dark transition-colors mt-2',
                  phase === 'submitting' && 'opacity-70 cursor-not-allowed'
                )}
              >
                {phase === 'submitting' && <Loader2 className="w-4 h-4 animate-spin" />}
                Send reset instructions
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
