'use client'

import { useEffect, useRef, useState } from 'react'
import PresenceBadge from '@/components/presence/PresenceBadge'
import { pickPresenceLabel } from '@/lib/presence/lastActive'
import { usePresenceContext, usePresenceLabel } from '@/components/presence/PresenceProvider'

const POLL_MS = 60 * 1000

/**
 * Single-member live presence badge (expanded Network modal, expanded Messages profile).
 *
 * When a PresenceProvider is in the tree (Network page / Messages), this DELEGATES to the
 * shared batched poll — so a card and the modal for the same member never poll twice. When
 * there is no provider (a lone profile page), it runs its own ~60s poll. Either way it seeds
 * from the server-rendered `initialLabel` until the first live result. A null / no-row result
 * (opt-out / offline / ≥7d) hides the badge. Uses only the privacy-filtered route — a coarse
 * label, never a raw timestamp. Fails silently in the UI.
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
  const ctx = usePresenceContext()
  const shared = usePresenceLabel(memberId) // string | null | undefined (provider path)
  const [standalone, setStandalone] = useState<string | null>(initialLabel)

  // Standalone poll ONLY when there is no surface provider.
  useEffect(() => {
    if (ctx || !memberId) return // provider drives updates
    let cancelled = false
    const refresh = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      try {
        const res = await fetch(`/api/presence/label?ids=${encodeURIComponent(memberId)}`, { cache: 'no-store' })
        if (!res.ok) return
        const json = await res.json()
        if (!cancelled) setStandalone(pickPresenceLabel(json, memberId)) // null → badge disappears
      } catch {
        /* fail silent — the route logs a safe diagnostic; keep the last known label */
      }
    }
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [ctx, memberId])

  // Provider present: use the shared map, seeded by initialLabel until the first fetch.
  const label = ctx ? (shared !== undefined ? shared : (initialLabel ?? null)) : standalone
  return <PresenceBadge label={label} className={className} />
}
