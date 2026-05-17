'use client'

import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
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

    const redirectTo = process.env.NEXT_PUBLIC_SITE_URL
      ? `${process.env.NEXT_PUBLIC_SITE_URL}/auth/reset-password`
      : `${window.location.origin}/auth/reset-password`

    const supabase = createClient()
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })

    if (resetError) {
      // Surface unexpected errors (e.g. rate limit), but not "email not found"
      // which Supabase doesn't distinguish anyway. Generic message prevents enumeration.
      console.error('[forgot-password] reset request error:', resetError.message)
      setError('Something went wrong. Please try again.')
      setPhase('compose')
      return
    }

    // Always show the same confirmation regardless of whether the email exists.
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
              If an account exists for that email, you'll receive password reset instructions shortly.
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
