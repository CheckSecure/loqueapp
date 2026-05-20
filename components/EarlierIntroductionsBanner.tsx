'use client'

import { useState } from 'react'

type Props = {
  count: number
  batchId: string
}

export default function EarlierIntroductionsBanner({ count, batchId }: Props) {
  const [hidden, setHidden] = useState(false)
  const [dismissing, setDismissing] = useState(false)

  if (hidden) return null

  function openEarlierSection() {
    const el = document.getElementById('earlier-introductions')
    if (el && el instanceof HTMLDetailsElement) {
      el.open = true
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  async function dismiss() {
    setHidden(true)
    setDismissing(true)
    try {
      await fetch('/api/introductions/dismiss-banner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId }),
      })
    } catch {
      // Best-effort: even if persistence fails, the banner stays hidden for this session.
    } finally {
      setDismissing(false)
    }
  }

  return (
    <div className="mb-6 bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 sm:px-5 sm:py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <p className="text-sm text-slate-700 leading-relaxed">
          You still have {count} earlier {count === 1 ? 'introduction' : 'introductions'} awaiting a response. Reviewing them helps us curate stronger future introductions.
        </p>
        <div className="flex items-center gap-3 flex-shrink-0">
          <button
            type="button"
            onClick={openEarlierSection}
            className="text-sm font-semibold text-brand-navy hover:underline whitespace-nowrap"
          >
            Review earlier introductions →
          </button>
          <button
            type="button"
            onClick={dismiss}
            disabled={dismissing}
            className="text-sm text-slate-500 hover:text-slate-700 transition-colors disabled:opacity-50"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}
