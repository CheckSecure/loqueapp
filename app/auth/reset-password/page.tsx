'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { emitMetric } from '@/lib/metrics'
import { Loader2, CheckCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

// Secure reset. The password update AND the clearing of the legacy `password_reset_required` flag
// happen SERVER-SIDE (POST /api/auth/complete-reset), never in the browser:
//   - the server updates the password using the authenticated recovery session (never logged);
//   - it clears the flag ONLY as a first-hand result of that update, and issues an HttpOnly,
//     signed, user-bound continuation cookie so a finalize-only retry needs no password;
//   - the sessionStorage marker below is DISPLAY ONLY — it decides whether to show the form or the
//     "finishing…" UI on a refresh, and can NEVER clear the flag (the server ignores it entirely).

type Phase = 'waiting' | 'ready' | 'submitting' | 'finalizing' | 'finalize_error' | 'success' | 'invalid'

// Per-tab DISPLAY hint only. Not proof of anything — the server is the sole authority.
const PW_SET_KEY = 'andrel:reset:pw_set'
const markPwSet = () => { try { sessionStorage.setItem(PW_SET_KEY, '1') } catch { /* ignore */ } }
const isPwSet = () => { try { return sessionStorage.getItem(PW_SET_KEY) === '1' } catch { return false } }
const clearPwSet = () => { try { sessionStorage.removeItem(PW_SET_KEY) } catch { /* ignore */ } }

async function postReset(payload: { mode: 'set'; password: string } | { mode: 'finalize' }) {
  const res = await fetch('/api/auth/complete-reset', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({} as any))
  return { status: res.status, data }
}

export default function ResetPasswordPage() {
  const [phase, setPhase] = useState<Phase>('waiting')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Stage 2 — finalize WITHOUT the password. Authorized server-side by the continuation cookie; a
  // stale/forged display marker just triggers this call, which the server rejects (→ finalize_error).
  const runFinalize = useCallback(async () => {
    setError(null)
    setPhase('finalizing')
    const { data } = await postReset({ mode: 'finalize' })
    if (data?.ok && data?.dest) {
      clearPwSet()
      setPhase('success')
      setTimeout(() => { window.location.href = data.dest }, 2000)
      return
    }
    setPhase('finalize_error') // includes a 401 when there is no valid server continuation
  }, [])

  useEffect(() => {
    const supabase = createClient()
    const check = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setPhase('invalid') // direct visit or expired link
        return
      }
      // DISPLAY decision only: if this tab already submitted a password, show the finishing UI and
      // let the server (via the continuation cookie) decide — never re-present the form here.
      if (isPwSet()) runFinalize()
      else setPhase('ready')
    }
    const timer = setTimeout(check, 500) // let the client hydrate the session from the fragment
    return () => clearTimeout(timer)
  }, [runFinalize])

  // Stage 1 — password submission. Reachable ONLY from the form (phase 'ready').
  async function handleReset(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (password !== confirm) { setError('Passwords do not match.'); return }

    setPhase('submitting')
    const { status, data } = await postReset({ mode: 'set', password })

    if (data?.ok && data?.dest) {
      // Server updated the password AND cleared the flag in one execution.
      emitMetric('recovery_password_changed')
      clearPwSet(); setPassword(''); setConfirm('')
      setPhase('success')
      setTimeout(() => { window.location.href = data.dest }, 2000)
      return
    }

    if (data?.stage === 'update') {
      // The password was NOT changed → safe to stay on the form and let the user retry.
      setError(data.message || 'Could not update your password. Please try again.')
      setPhase(status === 401 ? 'invalid' : 'ready')
      return
    }

    if (data?.stage === 'finalize') {
      // Password WAS changed server-side; only finalization failed. Never show the form again;
      // retry finalization WITHOUT the password. Mark the tab so a refresh resumes finalization.
      emitMetric('recovery_password_changed')
      markPwSet(); setPassword(''); setConfirm('')
      setPhase('finalize_error')
      return
    }

    // Auth/session problem or unexpected shape.
    setError(data?.message || 'Your session has expired. Please use the link again.')
    setPhase(status === 401 ? 'invalid' : 'ready')
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

          {/* Finalizing — password already set; NO password form is shown here. */}
          {phase === 'finalizing' && (
            <div className="flex items-center gap-3 text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              Finishing setting up your account…
            </div>
          )}

          {/* Finalization failed — the password IS set; retry finalization only, never the password. */}
          {phase === 'finalize_error' && (
            <div className="space-y-4">
              <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-4 rounded-lg leading-relaxed">
                Your password was updated, but we couldn’t finish preparing your account.
              </div>
              <button
                type="button"
                onClick={() => { runFinalize() }}
                className="w-full flex items-center justify-center gap-2 bg-brand-navy text-white text-sm font-semibold px-4 py-2.5 rounded-xl hover:bg-brand-navy-dark transition-colors"
              >
                Try again
              </button>
              <p className="text-xs text-slate-500">
                Your new password is saved. You can also{' '}
                <Link href="/login" className="font-semibold text-brand-navy hover:underline">sign in</Link>{' '}
                with it if this keeps happening.
              </p>
            </div>
          )}

          {/* Success */}
          {phase === 'success' && (
            <div className="flex items-start gap-3 bg-green-50 border border-green-200 text-green-800 text-sm px-4 py-4 rounded-lg">
              <CheckCircle className="w-4 h-4 mt-0.5 shrink-0 text-green-500" />
              <span>Password updated. Redirecting you to your dashboard…</span>
            </div>
          )}

          {/* New password form — ONLY before a successful updateUser */}
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
