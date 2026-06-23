'use client'

import { useState, useEffect, useRef } from 'react'
import { X, Loader2, AlertCircle, CheckCircle, Sparkles } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
}

/**
 * Andrel Concierge request modal.
 *
 * Backend: POST /api/concierge/submit (Phase 1 Step 1).
 *   - Server is the authoritative gate: requester_id comes from auth, tier is
 *     re-checked via getEffectiveTier(), inserts use the service-role client.
 *   - This modal only renders for eligible users (the launcher gates the entry
 *     point) — the 403 branch here is defense-in-depth, not the primary gate.
 *   - 409 => the user already has an active Concierge request.
 *
 * No credit logic — Concierge is membership-gated, not credit-metered. This is
 * a separate flow from the old targeted_requests modal.
 */
export default function ConciergeModal({ open, onClose }: Props) {
  const [targetPerson, setTargetPerson] = useState('')
  const [targetRole, setTargetRole] = useState('')
  const [targetCompany, setTargetCompany] = useState('')
  const [targetIndustry, setTargetIndustry] = useState('')
  const [reason, setReason] = useState('')
  const [notes, setNotes] = useState('')
  const [state, setState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const firstFieldRef = useRef<HTMLInputElement>(null)

  // Reset + focus on open.
  useEffect(() => {
    if (open) {
      setState('idle')
      setErrorMsg(null)
      setFieldErrors({})
      setTimeout(() => firstFieldRef.current?.focus(), 50)
    }
  }, [open])

  // Close on Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const hasTarget = [targetPerson, targetRole, targetCompany, targetIndustry].some((v) => v.trim())
  const canSubmit = hasTarget && reason.trim().length > 0 && state !== 'loading'

  async function submit() {
    setState('loading')
    setErrorMsg(null)
    setFieldErrors({})
    try {
      const res = await fetch('/api/concierge/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_person: targetPerson.trim() || null,
          target_role: targetRole.trim() || null,
          target_company: targetCompany.trim() || null,
          target_industry: targetIndustry.trim() || null,
          reason: reason.trim() || null,
          notes: notes.trim() || null,
        }),
      })

      if (res.ok) {
        setState('success')
        return
      }

      const body = await res.json().catch(() => ({}))

      if (res.status === 400 && body?.errors) {
        setFieldErrors(body.errors)
        setErrorMsg(body.message || 'Please fix the highlighted fields.')
        setState('error')
        return
      }
      if (res.status === 409) {
        setErrorMsg('You already have an active Concierge request.')
        setState('error')
        return
      }
      if (res.status === 403) {
        setErrorMsg('Concierge is available on Professional, Executive, and Founding plans.')
        setState('error')
        return
      }
      // 401 / 500 / anything else.
      setErrorMsg(body?.message || 'Something went wrong. Please try again.')
      setState('error')
    } catch (e: any) {
      setErrorMsg(e?.message || 'Network error. Please try again.')
      setState('error')
    }
  }

  const inputCls =
    'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:border-brand-navy focus:outline-none'

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center bg-slate-900/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-lg sm:mx-4 bg-white rounded-t-2xl sm:rounded-2xl shadow-xl border-t sm:border border-slate-200 max-h-[90vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-5 sm:px-6 pt-5 pb-3 border-b border-slate-100">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-brand-navy text-brand-gold flex items-center justify-center flex-shrink-0">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.18em] text-brand-gold font-bold">Andrel Concierge</p>
              <h2 className="text-base font-semibold text-brand-navy leading-tight">Need help making the right connection?</h2>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">Tell us who you&apos;d like to meet and our team will personally review your request and facilitate introductions when appropriate.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 -mt-1 -mr-1 p-1" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 sm:px-6 py-5 space-y-4">
          {state === 'success' ? (
            <div className="flex items-start gap-3 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3">
              <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-emerald-900">Your Concierge request has been submitted.</p>
                <p className="text-emerald-700 text-xs mt-0.5">Andrel will review it and identify the best introduction.</p>
              </div>
            </div>
          ) : (
            <>
              <div className="rounded-lg bg-brand-cream/40 border border-brand-gold/15 px-3.5 py-3">
                <p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400 mb-1.5">For example</p>
                <ul className="space-y-1 text-xs text-slate-600">
                  <li>Introduce me to a healthcare GC.</li>
                  <li>Looking for an energy litigator.</li>
                  <li>Seeking a growth-stage investor.</li>
                  <li>Exploring business development opportunities.</li>
                </ul>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Who are you looking to meet?</label>
                <input
                  ref={firstFieldRef}
                  type="text"
                  value={targetPerson}
                  onChange={(e) => setTargetPerson(e.target.value)}
                  placeholder="e.g. a specific person, or the kind of person"
                  maxLength={200}
                  className={inputCls}
                />
                {fieldErrors.target_person && <p className="text-xs text-red-600 mt-1">{fieldErrors.target_person}</p>}
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Target role or title</label>
                  <input
                    type="text"
                    value={targetRole}
                    onChange={(e) => setTargetRole(e.target.value)}
                    placeholder="e.g. General Counsel, CFO"
                    maxLength={200}
                    className={inputCls}
                  />
                  {fieldErrors.target_role && <p className="text-xs text-red-600 mt-1">{fieldErrors.target_role}</p>}
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Company or type of company</label>
                  <input
                    type="text"
                    value={targetCompany}
                    onChange={(e) => setTargetCompany(e.target.value)}
                    placeholder="e.g. Sequoia, or a PE-backed health co"
                    maxLength={200}
                    className={inputCls}
                  />
                  {fieldErrors.target_company && <p className="text-xs text-red-600 mt-1">{fieldErrors.target_company}</p>}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Industry</label>
                <input
                  type="text"
                  value={targetIndustry}
                  onChange={(e) => setTargetIndustry(e.target.value)}
                  placeholder="e.g. fintech, life sciences, public sector"
                  maxLength={200}
                  className={inputCls}
                />
                {fieldErrors.target_industry && <p className="text-xs text-red-600 mt-1">{fieldErrors.target_industry}</p>}
              </div>

              {fieldErrors.target && (
                <p className="text-xs text-red-600 -mt-1">{fieldErrors.target}</p>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Why would this introduction be valuable?</label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  placeholder="What you're trying to do — fundraise, hire, learn, partner."
                  maxLength={2000}
                  className={`${inputCls} resize-none`}
                />
                {fieldErrors.reason && <p className="text-xs text-red-600 mt-1">{fieldErrors.reason}</p>}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Additional notes <span className="text-slate-400 font-normal">(optional)</span></label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Anything else that helps Andrel make the right match."
                  maxLength={2000}
                  className={`${inputCls} resize-none`}
                />
                {fieldErrors.notes && <p className="text-xs text-red-600 mt-1">{fieldErrors.notes}</p>}
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

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 sm:px-6 pb-5 pt-2 border-t border-slate-100">
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors">
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
              Submit request
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
