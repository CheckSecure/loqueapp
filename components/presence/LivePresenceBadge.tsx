'use client'

import { useEffect, useRef, useState } from 'react'
import PresenceBadge from '@/components/presence/PresenceBadge'
import { pickPresenceLabel } from '@/lib/presence/lastActive'

const POLL_MS = 60 * 1000

/**
 * Live presence badge for the EXPANDED Network modal. The server-rendered label is only a
 * page-load snapshot — stale (or empty) by the time the modal opens — so this seeds from it
 * and then refreshes the COARSE label from /api/presence/label on open and every ~60s while
 * the modal is open AND the tab is visible.
 *
 * PRIVACY: uses only the privacy-filtered RPC (via the route) — a coarse label, never a raw
 * timestamp. A null / no-row response (offline, ≥7d, or opt-out) sets the label to null so
 * the badge disappears on the next refresh. Polling STOPS on unmount (modal close) and pauses
 * while the tab is hidden. Fails silently in the UI (the route logs a safe diagnostic).
 */
export default function LivePresenceBadge({
  memberId,
  initialLabel = null,
  className = '',
}: {
  memberId: string
  initialLabel?: string | null
  className?: string
}) {
  const [label, setLabel] = useState<string | null>(initialLabel)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      try {
        const res = await fetch(`/api/presence/label?ids=${encodeURIComponent(memberId)}`, { cache: 'no-store' })
        if (!res.ok) return
        const json = await res.json()
        if (!cancelled) setLabel(pickPresenceLabel(json, memberId)) // null → badge disappears
      } catch {
        /* fail silent — the route logs a safe diagnostic; keep the last known label */
      }
    }
    refresh() // on open
    timer.current = setInterval(refresh, POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      if (timer.current) clearInterval(timer.current)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [memberId])

  return <PresenceBadge label={label} className={className} />
}
