'use client'

import { useState } from 'react'

/**
 * Nominee-facing "remove my information" control. Deletion happens ONLY via POST
 * (this button) — never on page load — so an email-security scanner that auto-opens
 * the link can never delete anything. A confirmation step is required first.
 */
export default function ManageInformationForm({ token }: { token: string }) {
  const [phase, setPhase] = useState<'idle' | 'confirming' | 'working' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')

  async function remove() {
    setPhase('working')
    setError('')
    try {
      const res = await fetch('/api/manage-information/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error || 'Something went wrong. Please try again.')
        setPhase('error')
        return
      }
      setPhase('done')
    } catch {
      setError('Something went wrong. Please try again.')
      setPhase('error')
    }
  }

  if (phase === 'done') {
    return (
      <div className="rounded-xl border border-green-100 bg-green-50 px-4 py-3 text-sm text-green-800">
        Your information has been removed from Andrel. You will not be contacted again.
      </div>
    )
  }

  // Boolean (not a narrowed phase check) so the confirm block stays visible while
  // the removal is in flight (phase === 'working').
  const showConfirm = phase === 'confirming' || phase === 'working'

  return (
    <div className="space-y-4">
      {!showConfirm ? (
        <button
          type="button"
          onClick={() => setPhase('confirming')}
          className="w-full rounded-lg border border-red-200 bg-white px-4 py-3 text-sm font-semibold text-red-600 hover:bg-red-50 transition-colors"
        >
          Remove my information from Andrel
        </button>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
          <p className="text-sm text-slate-700">
            This permanently removes your name, email, and any details a member shared when recommending you.
            This cannot be undone. Continue?
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={remove}
              disabled={phase === 'working'}
              className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
            >
              {phase === 'working' ? 'Removing…' : 'Yes, remove my information'}
            </button>
            <button
              type="button"
              onClick={() => setPhase('idle')}
              disabled={phase === 'working'}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {phase === 'error' && error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  )
}
