'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { pickPresenceLabel } from '@/lib/presence/lastActive'
import { planPresenceBatches } from '@/lib/presence/batch'

// One shared, batched presence poll per SURFACE (Network page / Messages route tree). Every
// card / row / header / modal on that surface subscribes its member id; the provider fetches
// the coarse labels for ALL of them together (deduped, chunked to the endpoint's max) and
// distributes the result via one shared map — so there is NEVER one request per visible
// member, and a card + the modal for the same member share a single subscription.
//
// PRIVACY: reads go ONLY through the authenticated /api/presence/label route → the
// privacy-filtered member_presence_labels RPC. Only coarse labels are stored/returned; a raw
// timestamp never reaches the client. A member the RPC stops returning (opt-out / offline)
// becomes null in the map, so their badge disappears on the next refresh.

const MAX_IDS = 50 // must match the /api/presence/label route cap
const POLL_MS = 60 * 1000
const REFRESH_DEBOUNCE_MS = 250

interface PresenceCtx {
  labels: Record<string, string | null>
  subscribe: (id: string) => void
  unsubscribe: (id: string) => void
}

const Ctx = createContext<PresenceCtx | null>(null)

export function usePresenceContext(): PresenceCtx | null {
  return useContext(Ctx)
}

/**
 * Subscribe ONE member id to the surface poll; returns its coarse label:
 *   string    → a label to show,
 *   null      → fetched-but-absent (opt-out / offline / ≥7d) → hide the badge,
 *   undefined → unknown (no provider, or not fetched yet) → caller may show a server seed.
 */
export function usePresenceLabel(memberId: string | null | undefined): string | null | undefined {
  const ctx = usePresenceContext()
  useEffect(() => {
    if (!ctx || !memberId) return
    ctx.subscribe(memberId)
    return () => ctx.unsubscribe(memberId)
  }, [ctx, memberId])
  if (!ctx || !memberId) return undefined
  return ctx.labels[memberId]
}

/** Subscribe MANY member ids in one effect (avoids per-row hooks in a list). */
export function usePresenceLabels(memberIds: Array<string | null | undefined>): Record<string, string | null | undefined> {
  const ctx = usePresenceContext()
  const key = memberIds.filter(Boolean).join(',') // stable dep for the id set
  useEffect(() => {
    if (!ctx || !key) return
    const ids = key.split(',')
    ids.forEach((id) => ctx.subscribe(id))
    return () => ids.forEach((id) => ctx.unsubscribe(id))
  }, [ctx, key])
  const out: Record<string, string | null | undefined> = {}
  if (ctx) for (const id of memberIds) if (id) out[id] = ctx.labels[id]
  return out
}

export function PresenceProvider({ children }: { children: React.ReactNode }) {
  const [labels, setLabels] = useState<Record<string, string | null>>({})
  const counts = useRef<Map<string, number>>(new Map()) // ref-counted subscriptions
  const refreshRef = useRef<() => void>(() => {})
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleRefresh = useCallback(() => {
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => refreshRef.current(), REFRESH_DEBOUNCE_MS)
  }, [])

  const subscribe = useCallback((id: string) => {
    if (!id) return
    const prev = counts.current.get(id) ?? 0
    counts.current.set(id, prev + 1)
    if (prev === 0) scheduleRefresh() // a newly-visible member → fetch soon (still batched)
  }, [scheduleRefresh])

  const unsubscribe = useCallback((id: string) => {
    if (!id) return
    const n = (counts.current.get(id) ?? 0) - 1
    if (n <= 0) counts.current.delete(id)
    else counts.current.set(id, n)
  }, [])

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return // pause while hidden
      const batches = planPresenceBatches(Array.from(counts.current.keys()), MAX_IDS)
      if (batches.length === 0) return
      try {
        const next: Record<string, string | null> = {}
        for (const batch of batches) {
          const res = await fetch(`/api/presence/label?ids=${batch.map(encodeURIComponent).join(',')}`, { cache: 'no-store' })
          if (!res.ok) continue
          const json = await res.json()
          for (const id of batch) next[id] = pickPresenceLabel(json, id) // null → badge disappears
        }
        if (!cancelled) setLabels((prev) => ({ ...prev, ...next }))
      } catch {
        /* fail silent — the route logs a privacy-safe diagnostic */
      }
    }
    refreshRef.current = refresh
    refresh() // on mount
    const timer = setInterval(refresh, POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() } // resume + refresh
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(timer)
      if (debounce.current) clearTimeout(debounce.current)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return <Ctx.Provider value={{ labels, subscribe, unsubscribe }}>{children}</Ctx.Provider>
}
