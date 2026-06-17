'use client'

import { useState, useEffect, useRef } from 'react'
import { X, Loader2, AlertCircle, CheckCircle, Sparkles } from 'lucide-react'

interface Props {
  premiumCredits: number
  /** If a request is already pending, surface it so the user understands why submit is gated. */
  hasPendingRequest: boolean
  open: boolean
  onClose: () => void
}

/**
 * Targeted-introduction request modal.
 *
 * Backend: POST /api/targeted-request/submit (existing route, untouched).
 *   - Requires premium_credits >= 1
 *   - Body: { role?: string, industry?: string, intent?: string }
 *   - Returns 403 (no premium credit), 409 (pending request exists), or 200 with the inserted row.
 *
 * Credit gate is enforced client-side (disable submit) AND server-side (route returns 403).
 * No fake success path — the modal surfaces whatever the route returns.
 */
export default function TargetedRequestModal({ premiumCredits, hasPendingRequest, open, onClose }: Props) {
  const [role, setRole] = useState('')
  const [industry, setIndustry] = useState('')
  const [intent, setIntent] = useState('')
  const [state, setState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  // Focus first field on open + reset state when closed.
  useEffect(() => {
    if (open) {
      setState('idle')
      setErrorMsg(null)
      setTimeout(() => firstFieldRef.current?.focus(), 50)
    }
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const canSubmit = premiumCredits >= 1 && !hasPendingRequest && state !== 'loading'

  async function submit() {
    setState('loading')
    setErrorMsg(null)
    try {
      const res = await fetch('/api/targeted-request/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: role.trim() || null,
          industry: industry.trim() || null,
          intent: intent.trim() || null,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setErrorMsg(body.message || body.error || `Server returned ${res.status}`)
        setState('error')
        return
      }
      // Real success — the route returns { success: true, request, message }
      setState('success')
    } catch (e: any) {
      setErrorMsg(e?.message || 'Network error')
      setState('error')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center bg-slate-900/40 backdrop-blur-sm" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-lg sm:mx-4 bg-white rounded-t-2xl sm:rounded-2xl shadow-xl border-t sm:border border-slate-200 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-start justify-between gap-4 px-5 sm:px-6 pt-5 pb-3 border-b border-slate-100">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-brand-gold-soft border border-brand-gold/20 flex items-center justify-center flex-shrink-0">
              <Sparkles className="w-5 h-5 text-brand-gold" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900 leading-tight">Request a targeted introduction</h2>
              <p className="text-xs text-slate-500 mt-0.5">Andrel prioritizes the kind of person you describe in your next batch.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 -mt-1 -mr-1 p-1"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 sm:px-6 py-5 space-y-4">
          {state === 'success' ? (
            <div className="flex items-start gap-3 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3">
              <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-emerald-900">Targeted request submitted.</p>
                <p className="text-emerald-700 text-xs mt-0.5">Your next batch will prioritize matches aligned with this intent. We'll let you know when it's surfaced.</p>
              </div>
            </div>
          ) : (
            <>
              {/* Credit / pending state surface */}
              {hasPendingRequest && (
                <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5 text-xs text-amber-900">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>You already have an active targeted request. It'll apply to your next batch — wait or withdraw it before submitting another.</span>
                </div>
              )}
              {!hasPendingRequest && premiumCredits < 1 && (
                <div className="flex items-start gap-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2.5 text-xs text-slate-700">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>Targeted requests use one premium credit. Your premium balance is {premiumCredits}.</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Role / type of person</label>
                <input
                  ref={firstFieldRef}
                  type="text"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder="e.g. Series A investor, healthcare GC, fractional CFO"
                  maxLength={140}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Industry / context <span className="text-slate-400 font-normal">(optional)</span></label>
                <input
                  type="text"
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  placeholder="e.g. fintech, life sciences, public sector"
                  maxLength={140}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">What are you trying to do?</label>
                <textarea
                  value={intent}
                  onChange={(e) => setIntent(e.target.value)}
                  rows={3}
                  placeholder="One sentence on the conversation you want — fundraise, hire, learn, partner."
                  maxLength={500}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-navy focus:outline-none resize-none"
                />
              </div>

              {errorMsg && (
                <div className="flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2.5 text-xs text-red-800">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>{errorMsg}</span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 sm:px-6 pb-5 pt-2 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors"
          >
            {state === 'success' ? 'Done' : 'Cancel'}
          </button>
          {state !== 'success' && (
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-brand-navy text-white hover:bg-brand-navy/90 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed transition-colors"
            >
              {state === 'loading' && <Loader2 className="w-4 h-4 animate-spin" />}
              Submit (uses 1 premium credit)
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
