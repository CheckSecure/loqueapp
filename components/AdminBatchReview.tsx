'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle, Loader2, Trash2, Users, Sparkles, ChevronDown, ChevronUp, ExternalLink, X } from 'lucide-react'

interface Suggestion {
  id: string
  suggested_id: string
  reason: string
  match_score: number
  suggested_profile: {
    id?: string
    full_name: string
    title: string
    company: string
    role_type: string
    bio?: string
    email?: string
  }
}

interface RecipientGroup {
  recipient_id: string
  recipient_name: string
  recipient_role: string
  suggestions: Suggestion[]
}

interface Batch {
  id: string
  batch_number: number
  week_start: string
  week_end: string
  status: string
  groups: RecipientGroup[]
}

export default function AdminBatchReview({ batch }: { batch: Batch }) {
  const router = useRouter()
  const [groups, setGroups] = useState<RecipientGroup[]>(batch.groups)
  const [approving, setApproving] = useState(false)
  const [deletingBatch, setDeletingBatch] = useState(false)
  const [approved, setApproved] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [removing, setRemoving] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<{ suggestionId: string; recipientId: string; name: string } | null>(null)
  const [previewProfile, setPreviewProfile] = useState<Suggestion['suggested_profile'] | null>(null)

  const totalSuggestions = groups.reduce((sum, g) => sum + g.suggestions.length, 0)

  const handleRemove = async (recipientId: string, suggestionId: string) => {
    setRemoving(suggestionId)
    setConfirmRemove(null)
    try {
      await fetch('/api/admin/batch-suggestion', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestionId }),
      })
      setGroups(prev =>
        prev
          .map(g => {
            if (g.recipient_id !== recipientId) return g
            return { ...g, suggestions: g.suggestions.filter(s => s.id !== suggestionId) }
          })
          .filter(g => g.suggestions.length > 0)
      )
    } catch (err) {
      console.error('Failed to remove suggestion')
    }
    setRemoving(null)
  }

  const handleApprove = async () => {
    setApproving(true)
    try {
      const res = await fetch('/api/admin/approve-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: batch.id }),
      })
      const data = await res.json()
      if (data.success) {
        setApproved(true)
        router.refresh()
      }
    } catch (err) {
      console.error('Failed to approve batch')
    }
    setApproving(false)
  }

  const handleDeleteBatch = async () => {
    if (!confirm('Delete this entire batch? This cannot be undone.')) return
    setDeletingBatch(true)
    try {
      await fetch('/api/admin/delete-batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: batch.id }),
      })
      router.refresh()
    } catch (err) {
      console.error('Failed to delete batch')
    }
    setDeletingBatch(false)
  }

  if (approved) {
    return (
      <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 px-4 py-3 rounded-xl">
        <CheckCircle className="w-4 h-4" />
        Batch {batch.batch_number} is now live for all members.
      </div>
    )
  }

  return (
    <>
      {/* Profile preview modal */}
      {previewProfile && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center px-4" onClick={() => setPreviewProfile(null)}>
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 relative" onClick={e => e.stopPropagation()}>
            <button onClick={() => setPreviewProfile(null)} className="absolute top-4 right-4 text-slate-400 hover:text-slate-600">
              <X className="w-4 h-4" />
            </button>
            <p className="text-lg font-bold text-slate-900 mb-1">{previewProfile.full_name}</p>
            <p className="text-sm text-slate-500 mb-1">{[previewProfile.title, previewProfile.company].filter(Boolean).join(' at ')}</p>
            {previewProfile.role_type && <p className="text-xs text-slate-400 mb-3">{previewProfile.role_type}</p>}
            {previewProfile.bio && <p className="text-sm text-slate-600 leading-relaxed">{previewProfile.bio}</p>}
            {previewProfile.email && <p className="text-xs text-slate-400 mt-3">{previewProfile.email}</p>}
          </div>
        </div>
      )}

      {/* Confirm remove modal */}
      {confirmRemove && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6">
            <p className="text-sm font-semibold text-slate-900 mb-2">Remove {confirmRemove.name}?</p>
            <p className="text-xs text-slate-500 mb-4">This will remove them from this batch. This cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmRemove(null)} className="flex-1 px-4 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
                Cancel
              </button>
              <button
                onClick={() => handleRemove(confirmRemove.recipientId, confirmRemove.suggestionId)}
                disabled={!!removing}
                className="flex-1 px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-60"
              >
                {removing ? <Loader2 className="w-3.5 h-3.5 animate-spin mx-auto" /> : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white border border-amber-200 rounded-xl shadow-sm overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-amber-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#C4922A]" />
            <div>
              <p className="text-sm font-semibold text-slate-900">Batch {batch.batch_number} — Pending Review</p>
              <p className="text-xs text-slate-400 mt-0.5">
                {batch.week_start} to {batch.week_end} · {totalSuggestions} suggestions across {groups.length} members
              </p>
            </div>
          </div>
          <button
            onClick={handleApprove}
            disabled={approving || totalSuggestions === 0}
            className="flex items-center gap-2 text-sm font-semibold bg-[#C4922A] text-white px-4 py-2 rounded-lg hover:bg-[#b07e21] transition-colors disabled:opacity-60"
          >
            {approving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
            {approving ? 'Approving...' : 'Approve & Go Live'}
          </button>
        </div>

        {/* Per-user groups */}
        <div className="divide-y divide-slate-50">
          {groups.map(group => (
            <div key={group.recipient_id}>
              <button
                type="button"
                onClick={() => setExpanded(prev => ({ ...prev, [group.recipient_id]: !prev[group.recipient_id] }))}
                className="w-full flex items-center justify-between px-5 py-3 hover:bg-slate-50 transition-colors text-left"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <Users className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                  <span className="text-sm font-semibold text-slate-900">{group.recipient_name}</span>
                  <span className="text-xs text-slate-400">{group.recipient_role}</span>
                  <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                    {group.suggestions.length} suggestion{group.suggestions.length !== 1 ? 's' : ''}
                  </span>
                </div>
                {expanded[group.recipient_id]
                  ? <ChevronUp className="w-4 h-4 text-slate-400 flex-shrink-0" />
                  : <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" />
                }
              </button>

              {expanded[group.recipient_id] && (
                <div className="px-5 pb-4 space-y-2 bg-slate-50/50">
                  {group.suggestions.map(s => (
                    <div key={s.id} className="flex items-start justify-between gap-3 bg-white border border-slate-100 rounded-xl px-4 py-3 shadow-sm">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                          <p className="text-sm font-semibold text-slate-900">{s.suggested_profile.full_name}</p>
                          <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">Score: {s.match_score}</span>
                          <button
                            type="button"
                            onClick={() => setPreviewProfile(s.suggested_profile)}
                            className="flex items-center gap-0.5 text-xs text-[#1B2850] hover:underline"
                          >
                            <ExternalLink className="w-3 h-3" />
                            View
                          </button>
                        </div>
                        <p className="text-xs text-slate-500">
                          {[s.suggested_profile.title, s.suggested_profile.company].filter(Boolean).join(' at ')}
                        </p>
                        {s.suggested_profile.role_type && (
                          <p className="text-xs text-slate-400 mt-0.5">{s.suggested_profile.role_type}</p>
                        )}
                        {s.reason && (
                          <p className="text-xs text-[#C4922A] italic mt-1.5">{s.reason}</p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setConfirmRemove({ suggestionId: s.id, recipientId: group.recipient_id, name: s.suggested_profile.full_name })}
                        disabled={removing === s.id}
                        className="flex-shrink-0 p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-40"
                        title="Remove from batch"
                      >
                        {removing === s.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
