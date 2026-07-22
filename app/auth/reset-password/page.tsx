'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { emitMetric } from '@/lib/metrics'
import { Loader2, CheckCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

// Magic-link flow: the user clicked a sign-in link from the forgot-password
// email. Supabase signed them in and redirected here with an active session.
// This page checks for that session on mount and immediately shows the
// "set new password" form. No token exchange, no auth-event listening,
// no recovery-specific URL parsing — just getUser() then updateUser().

type Phase = 'waiting' | 'ready' | 'submitting' | 'success' | 'invalid'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('waiting')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createClient()

    // The Supabase client processes the URL fragment on initialisation and
    // establishes the session. Give it a tick to complete before calling
    // getUser(), then check whether we're authenticated.
    const check = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        setPhase('ready')
      } else {
        // Not authenticated — either a direct visit or the link has expired.
        setPhase('invalid')
      }
    }

    // Small delay lets the Supabase client finish hydrating the session from
    // the URL fragment before we query it.
    const timer = setTimeout(check, 500)
    return () => clearTimeout(timer)
  }, [])

  async function handleReset(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setPhase('submitting')
    const supabase = createClient()
    const { error: updateError } = await supabase.auth.updateUser({ password })

    if (updateError) {
      console.error('[reset-password] updateUser error:', updateError.message)
      setError(
        updateError.message.includes('expired') || updateError.message.includes('invalid')
          ? 'This link has expired. Please request a new one.'
          : updateError.message
      )
      setPhase('ready')
      return
    }

    emitMetric('recovery_password_changed')
    setPhase('success')
    setTimeout(() => router.push('/dashboard/introductions'), 2500)
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
            <p className="text-lg font-medium mb-1.5 text-white">Choose a new password.</p>
            <p className="text-sm text-white/60">You'll be signed in automatically after resetting.</p>
          </div>
        </div>
        <p className="text-white/40 text-sm">© {new Date().getFullYear()} Andrel</p>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8">
            <Link href="/" className="text-xl font-bold text-brand-navy lg:hidden block mb-6 tracking-tight">Andrel</Link>
            <h2 className="text-2xl font-bold text-slate-900">Set new password</h2>
          </div>

          {/* Checking session */}
          {phase === 'waiting' && (
            <div className="flex items-center gap-3 text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              Verifying…
            </div>
          )}

          {/* Invalid / expired / direct visit */}
          {phase === 'invalid' && (
            <div className="space-y-4">
              <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-4 rounded-lg leading-relaxed">
                This link is invalid or has expired. Links are single-use and expire after one hour.
              </div>
              <Link
                href="/auth/forgot-password"
                className="inline-block text-sm font-semibold text-brand-navy hover:underline"
              >
                Request a new link
              </Link>
            </div>
          )}

          {/* Success */}
          {phase === 'success' && (
            <div className="flex items-start gap-3 bg-green-50 border border-green-200 text-green-800 text-sm px-4 py-4 rounded-lg">
              <CheckCircle className="w-4 h-4 mt-0.5 shrink-0 text-green-500" />
              <span>Password updated. Redirecting you to your dashboard…</span>
            </div>
          )}

          {/* New password form */}
          {(phase === 'ready' || phase === 'submitting') && (
            <form onSubmit={handleReset} className="space-y-4">
              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">
                  {error}
                  {error.includes('expired') && (
                    <div className="mt-2">
                      <Link href="/auth/forgot-password" className="font-semibold hover:underline">
                        Request a new link
                      </Link>
                    </div>
                  )}
                </div>
              )}
              <div>
                <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1.5">
                  New password
                </label>
                <input
                  id="password"
                  type="password"
                  required
                  autoComplete="new-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-gold focus:border-transparent transition"
                  placeholder="At least 8 characters"
                />
              </div>
              <div>
                <label htmlFor="confirm" className="block text-sm font-medium text-slate-700 mb-1.5">
                  Confirm password
                </label>
                <input
                  id="confirm"
                  type="password"
                  required
                  autoComplete="new-password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-gold focus:border-transparent transition"
                  placeholder="••••••••"
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
                Update password
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
