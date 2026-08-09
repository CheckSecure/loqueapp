'use client'

import { useEffect, useRef } from 'react'

/**
 * Invisible presence heartbeat mounted in the dashboard layout. Pings
 * POST /api/profile/heartbeat while a tab is open, at most once per ~1 min. The server
 * independently throttles the DB write to once/3 min, so pinging every minute keeps
 * last_active_at fresh enough (worst-case staleness ≈ 4 min) to stay inside the 5-minute
 * "Online now" window — while the server throttle still bounds writes to once/3 min. Also
 * pings on tab re-focus (returning refreshes presence). Sends NO data (member id comes from
 * the server session). Fire-and-forget: any network error is swallowed (the server logs its
 * own failures); it never affects the UI or navigation.
 */
const MIN_INTERVAL_MS = 60 * 1000

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
