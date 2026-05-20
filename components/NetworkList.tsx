'use client'

import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import NetworkCard from '@/components/NetworkCard'

type Connection = {
  matchId: string
  profile: any
  connectedAt: string | null
  isNew: boolean
  matchInsights?: { text: string; kind: string }[]
  conversationId?: string | null
}

type SortBy = 'recent' | 'name' | 'company'

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: 'recent', label: 'Most recent' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'company', label: 'Company' },
]

export default function NetworkList({ connections }: { connections: Connection[] }) {
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('recent')

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? connections.filter(c => {
          const p = c.profile || {}
          const haystack = [p.full_name, p.company, p.title]
            .filter(Boolean)
            .map((s: string) => s.toLowerCase())
          return haystack.some(h => h.includes(q))
        })
      : connections

    const sorted = [...filtered].sort((a, b) => {
      const ap = a.profile || {}
      const bp = b.profile || {}
      switch (sortBy) {
        case 'name': {
          const an = (ap.full_name || '').toLowerCase()
          const bn = (bp.full_name || '').toLowerCase()
          return an.localeCompare(bn)
        }
        case 'company': {
          const ac = (ap.company || '').toLowerCase()
          const bc = (bp.company || '').toLowerCase()
          // Empty companies sort to the bottom so populated ones surface first.
          if (!ac && bc) return 1
          if (ac && !bc) return -1
          return ac.localeCompare(bc)
        }
        case 'recent':
        default: {
          const at = a.connectedAt ? new Date(a.connectedAt).getTime() : 0
          const bt = b.connectedAt ? new Date(b.connectedAt).getTime() : 0
          return bt - at
        }
      }
    })

    return sorted
  }, [connections, query, sortBy])

  return (
    <>
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your network..."
            className="w-full text-sm pl-9 pr-3 py-2 rounded-xl border border-slate-200 placeholder:text-slate-400 bg-white focus:outline-none focus:border-brand-navy focus:ring-1 focus:ring-brand-navy"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <span className="sr-only sm:not-sr-only">Sort</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortBy)}
            className="text-sm py-2 pl-3 pr-8 rounded-xl border border-slate-200 bg-white text-slate-700 focus:outline-none focus:border-brand-navy focus:ring-1 focus:ring-brand-navy"
          >
            {SORT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>

      {visible.length === 0 ? (
        <div className="text-sm text-slate-500 px-1 py-6">
          No connections match &ldquo;{query}&rdquo;.
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {visible.map(({ matchId, profile, connectedAt, isNew, matchInsights, conversationId }) => (
            <NetworkCard
              key={matchId}
              matchId={matchId}
              profile={profile}
              connectedAt={connectedAt}
              isNew={isNew}
              matchInsights={matchInsights}
              conversationId={conversationId}
            />
          ))}
        </div>
      )}
    </>
  )
}
