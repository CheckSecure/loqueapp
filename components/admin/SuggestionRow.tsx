'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'

interface SuggestedUser {
  full_name: string | null
  title: string | null
  company: string | null
  role_type: string | null
}

interface Suggestion {
  id: string
  status: string
  match_score: number | null
  score_bucket: string
  reason: string | null
  position: number
}

function scoreBucketLabel(bucket: string): string {
  if (bucket === 'high_score') return 'High'
  if (bucket === 'mid_score') return 'Medium'
  if (bucket === 'low_score') return 'Low'
  return bucket
}

function scoreBucketColor(bucket: string): string {
  if (bucket === 'high_score') return 'bg-emerald-50 text-emerald-700 border-emerald-100'
  if (bucket === 'mid_score') return 'bg-amber-50 text-amber-700 border-amber-100'
  if (bucket === 'low_score') return 'bg-slate-50 text-slate-600 border-slate-100'
  return 'bg-slate-50 text-slate-600 border-slate-100'
}

export default function SuggestionRow({
  suggestion,
  suggested,
  index,
}: {
  suggestion: Suggestion
  suggested: SuggestedUser | null
  index: number
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isDropped = suggestion.status === 'dropped'

  const handleAction = async (action: 'drop' | 'restore') => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/batch-suggestions/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestionId: suggestion.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error || 'Action failed')
        setBusy(false)
        return
      }
      router.refresh()
      setBusy(false)
    } catch {
      setError('Network error')
      setBusy(false)
    }
  }

  return (
    <div className={`px-6 py-4 ${isDropped ? 'opacity-50' : ''}`}>
      <div className="flex items-start justify-between gap-4 mb-2">
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold text-slate-900 truncate ${isDropped ? 'line-through' : ''}`}>
            {index + 1}. {suggested?.full_name || 'Unknown'}
          </p>
          <p className="text-xs text-slate-500 mt-0.5 truncate">
            {suggested?.title || ''}{suggested?.company ? ` at ${suggested.company}` : ''}
            {suggested?.role_type ? ` · ${suggested.role_type}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={`text-xs font-medium px-2 py-1 rounded border ${scoreBucketColor(suggestion.score_bucket)}`}>
            {scoreBucketLabel(suggestion.score_bucket)} · {suggestion.match_score}
          </span>
          {isDropped ? (
            <button
              onClick={() => handleAction('restore')}
              disabled={busy}
              className="text-xs font-medium px-3 py-1 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-60 inline-flex items-center gap-1"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              Restore
            </button>
          ) : (
            <button
              onClick={() => handleAction('drop')}
              disabled={busy}
              className="text-xs font-medium px-3 py-1 rounded border border-red-200 bg-white text-red-700 hover:bg-red-50 disabled:opacity-60 inline-flex items-center gap-1"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              Drop
            </button>
          )}
        </div>
      </div>
      {suggestion.reason ? (
        <p className="text-xs text-slate-600 leading-relaxed mt-2">
          {suggestion.reason}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-red-600 mt-2">{error}</p>
      ) : null}
    </div>
  )
}
