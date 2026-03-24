'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle, Loader2, Trash2, Users, Sparkles, ChevronDown, ChevronUp } from 'lucide-react'

interface Suggestion {
  id: string
  suggested_id: string
  reason: string
  match_score: number
  suggested_profile: {
    full_name: string
    title: string
    company: string
    role_type: string
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
  const [approved, setApproved] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [removing, setRemoving] = useState<string | null>(null)

  const totalSuggestions = groups.reduce((sum, g) => sum + g.suggestions.length, 0)

  const handleRemove = async (recipientId: string, suggestionId: string) => {
    setRemoving(suggestionId)
    try {
      await fetch('/api/admin/batch-suggestion', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestionId }),
      })
      setGroups(prev => prev.map(g => {
        if (g.recipient_id !== recipientId) return g
        return { ...g, suggestions: g.suggestions.filter(s => s.id !== suggestionId) }
      }).filter(g => g.suggestions.length > 0))
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

  if (approved) {
    return (
      <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 px-4 py-3 rounded-xl">
        <CheckCircle className="w-4 h-4" />
        Batch {batch.batch_number} is now live for all members.
      </div>
    )
  }

  return (
    <div className="bg-white border border-amber-200 rounded-xl shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-amber-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-[#C4922A]" />
          <div>
            <p className="text-sm font-semibold text-slate-900">
              Batch {batch.batch_number} — Pending Review
            </p>
            <p className="text-xs text-slate-400 mt-0.5">
              {batch.week_start} → {batch.week_end} · {totalSuggestions} suggestions across {groups.length} members
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
              onClick={() => setExpanded(e => ({ ...e, [group.recipient_id]: !e[group.recipient_id] }))}
              className="w-full flex items-center justify-between px-5 py-3 hover:bg-slate-50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <Users className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-sm font-medium text-slate-900">{group.recipient_name}</span>
                <span className="text-xs text-slate-400">{group.recipient_role}</span>
                <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                  {group.suggestions.length} suggestions
                </span>
              </div>
              {expanded[group.recipient_id]
                ? <ChevronUp className="w-4 h-4 text-slate-400" />
                : <ChevronDown className="w-4 h-4 text-slate-400" />
              }
            </button>

            {expanded[group.recipient_id] && (
              <div className="px-5 pb-4 space-y-2">
                {group.suggestions.map(s => (
                  <div key={s.id} className="flex items-start justify-between gap-3 bg-slate-50 rounded-lg px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-sm font-semibold text-slate-900">{s.suggested_profile.full_name}</p>
                        <span className="text-xs text-slate-400">Score: {s.match_score}</span>
                      </div>
                      <p className="text-xs text-slate-500">
                        {[s.suggested_profile.title, s.suggested_profile.company].filter(Boolean).join(' at ')}
                      </p>
                      {s.reason && (
                        <p className="text-xs text-[#C4922A] italic mt-1">{s.reason}</p>

cd ~/loqueapp && python3 << 'ENDOFFILE'
content = open('app/dashboard/admin/page.tsx').read()

# Add AdminBatchReview import
content = content.replace(
    "import AdminBatchButton from '@/components/AdminBatchButton'",
    "import AdminBatchButton from '@/components/AdminBatchButton'\nimport AdminBatchReview from '@/components/AdminBatchReview'"
)

# Add pending batch fetch to Promise.all
content = content.replace(
    "  ] = await Promise.all([",
    "  { data: pendingBatches },\n  ] = await Promise.all([\n    supabase.from('introduction_batches').select('id, batch_number, week_start, week_end, status').eq('status', 'pending_review').order('created_at', { ascending: false }),"
)

# Add batch review UI after AdminBatchButton section
old = """          <AdminBatchButton />
          </div>
        </div>
        </section>"""

new = """          <AdminBatchButton />
          </div>
        </div>

        {/* Pending batch reviews */}
        {(pendingBatches ?? []).length > 0 && (
          <div className="mt-6 space-y-4">
            {await Promise.all((pendingBatches ?? []).map(async (batch: any) => {
              const { data: suggestions } = await supabase
                .from('batch_suggestions')
                .select('id, recipient_id, suggested_id, reason, match_score, profiles!suggested_id(full_name, title, company, role_type)')
                .eq('batch_id', batch.id)
                .eq('status', 'active')

              const { data: recipientProfiles } = await supabase
                .from('profiles')
                .select('id, full_name, role_type')
                .in('id', [...new Set((suggestions ?? []).map((s: any) => s.recipient_id))])

              const recipientMap: Record<string, any> = {}
              for (const p of recipientProfiles ?? []) recipientMap[p.id] = p

              const groups: Record<string, any> = {}
              for (const s of suggestions ?? []) {
                if (!groups[s.recipient_id]) {
                  const rp = recipientMap[s.recipient_id] ?? {}
                  groups[s.recipient_id] = {
                    recipient_id: s.recipient_id,
                    recipient_name: rp.full_name ?? 'Unknown',
                    recipient_role: rp.role_type ?? '',
                    suggestions: [],
                  }
                }
                groups[s.recipient_id].suggestions.push({
                  id: s.id,
                  suggested_id: s.suggested_id,
                  reason: s.reason,
                  match_score: s.match_score,
                  suggested_profile: (s as any).profiles ?? {},
                })
              }

              return (
                <AdminBatchReview
                  key={batch.id}
                  batch={{
                    id: batch.id,
                    batch_number: batch.batch_number,
                    week_start: batch.week_start,
                    week_end: batch.week_end,
                    status: batch.status,
                    groups: Object.values(groups),
                  }}
                />
              )
            }))}
          </div>
        )}
        </section>"""

content = content.replace(old, new)
open('app/dashboard/admin/page.tsx', 'w').write(content)
print('done')
