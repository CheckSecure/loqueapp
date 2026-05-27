'use client'

import { useEffect, useState } from 'react'
import { Info } from 'lucide-react'

// Lightweight one-time-per-browser page hint. Dismissal persists in
// localStorage under `andrel:hint:dismissed:${hintKey}`. Per-browser only —
// no cross-device persistence in V1.
//
// Starts hidden and reveals in an effect (rather than reading localStorage
// during render) so server and initial client render match — avoids a
// hydration mismatch and a flash for users who already dismissed.
export default function PageHint({ hintKey, children }: { hintKey: string; children: React.ReactNode }) {
  const [visible, setVisible] = useState(false)
  const storageKey = `andrel:hint:dismissed:${hintKey}`

  useEffect(() => {
    try {
      if (!localStorage.getItem(storageKey)) setVisible(true)
    } catch {
      // localStorage unavailable (e.g. private mode) — show the hint anyway;
      // it just won't persist as dismissed.
      setVisible(true)
    }
  }, [storageKey])

  if (!visible) return null

  function dismiss() {
    try { localStorage.setItem(storageKey, '1') } catch {}
    setVisible(false)
  }

  return (
    <div className="mb-6 flex items-start gap-3 bg-slate-50 border border-slate-100 rounded-xl px-4 py-3">
      <Info className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
      <p className="flex-1 min-w-0 text-sm text-slate-700 leading-relaxed">{children}</p>
      <button
        onClick={dismiss}
        className="flex-shrink-0 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors"
      >
        Dismiss
      </button>
    </div>
  )
}
