'use client'

import { useEffect, useRef } from 'react'

/**
 * Invisible presence heartbeat mounted in the dashboard layout. Pings
 * POST /api/profile/heartbeat while a tab is open, throttled client-side to at most once
 * per ~4.5 min (the server independently throttles to 5 min). Also pings when the tab
 * becomes visible again (returning to an active tab refreshes presence) — still throttled,
 * so it never floods writes. Sends NO data (member id comes from the server session).
 * Fully fire-and-forget: any error is swallowed and never affects the UI or navigation.
 */
const MIN_INTERVAL_MS = 4.5 * 60 * 1000

export default function PresenceHeartbeat() {
  const lastPing = useRef(0)

  useEffect(() => {
    const ping = () => {
      const now = Date.now()
      if (now - lastPing.current < MIN_INTERVAL_MS) return
      lastPing.current = now
      fetch('/api/profile/heartbeat', { method: 'POST', keepalive: true }).catch(() => {})
    }
    ping() // once on mount
    const id = setInterval(ping, MIN_INTERVAL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') ping() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return null
}
