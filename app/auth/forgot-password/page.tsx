'use client'

import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { emitMetric } from '@/lib/metrics'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

type Phase = 'compose' | 'submitting' | 'sent'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [phase, setPhase] = useState<Phase>('compose')
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setPhase('submitting')

    // Land on the scanner-resistant intermediate page (/auth/recover), which verifies the
    // token only on an explicit click — never on the email scanner's prefetch GET. NOTE:
    // full prefetch-resistance also requires the Supabase email template to use a
    // {{ .TokenHash }} link to /auth/recover (see lib/matching README / deploy notes).
    const redirectTo = process.env.NEXT_PUBLIC_SITE_URL
      ? `${process.env.NEXT_PUBLIC_SITE_URL}/auth/recover`
      : `${window.location.origin}/auth/recover`

    const supabase = createClient()
    // Magic-link sign-in: bypasses the broken Supabase password-recovery flow.
    // shouldCreateUser: false prevents new-account creation via this path.
    // The user receives a sign-in link, clicks it, lands on /auth/reset-password
    // already authenticated, and is prompted to set a new password.
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
    })

    if (otpError) {
      // Surface unexpected errors (e.g. rate limit). Generic message prevents
      // email enumeration — Supabase returns the same response for unknown emails
      // when shouldCreateUser: false, so we never reveal whether the account exists.
      console.error('[forgot-password] otp request error:', otpError.message)
      setError('Something went wrong. Please try again.')
      setPhase('compose')
      return
    }

    // Always show the same confirmation regardless of whether the email exists.
    emitMetric('recovery_email_requested')
    setPhase('sent')
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
            <div className="bg-green-50 border border-green-200 text-green-800 text-sm px-4 py-4 rounded-lg leading-relaxed">
              If an account exists for that email, you'll receive a sign-in link shortly.
              Check your spam folder if it doesn't arrive within a few minutes.
              <div className="mt-4">
                <Link href="/login" className="text-brand-navy font-semibold hover:underline text-sm">
                  Back to sign in
                </Link>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">
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
