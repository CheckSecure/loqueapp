'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Pill } from '@/components/ui/Pill'
import { Loader2, Search } from 'lucide-react'

interface RequesterProfile {
  full_name: string | null
  email: string | null
}

interface ConciergeRequest {
  id: string
  requester_id: string
  target_person: string | null
  target_role: string | null
  target_company: string | null
  target_industry: string | null
  reason: string | null
  notes: string | null
  status: string
  created_at: string
  updated_at: string
  // PostgREST embeds a to-one relation as an object, but supabase-js types it
  // loosely — normalize both shapes in the row renderer.
  requester: RequesterProfile | RequesterProfile[] | null
}

function statusVariant(status: string): 'gold' | 'navy' | 'success' | 'info' | 'default' {
  if (status === 'pending') return 'gold'
  if (status === 'reviewing') return 'navy'
  if (status === 'match_found') return 'info'
  if (status === 'introduced') return 'success'
  return 'default' // closed
}

function statusLabel(status: string): string {
  if (status === 'pending') return 'Pending'
  if (status === 'reviewing') return 'Reviewing'
  if (status === 'match_found') return 'Match found'
  if (status === 'introduced') return 'Introduced'
  if (status === 'closed') return 'Closed'
  return status
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric'
  return d.toLocaleDateString('en-US', opts)
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-800">{value || <span className="text-slate-400">—</span>}</dd>
    </div>
  )
}

interface Candidate {
  id: string
  name: string
  title: string | null
  company: string | null
  seniority: string | null
  score: number
  reason: string | null
}

export default function AdminConciergeClient({ requests }: { requests: ConciergeRequest[] }) {
  const router = useRouter()
  const [processing, setProcessing] = useState<string | null>(null)
  const [errorById, setErrorById] = useState<Record<string, string>>({})

  // Read-only candidate recommendations, fetched on demand per request.
  const [findingId, setFindingId] = useState<string | null>(null)
  const [candidatesById, setCandidatesById] = useState<Record<string, Candidate[]>>({})
  const [candErrorById, setCandErrorById] = useState<Record<string, string>>({})

  async function findCandidates(id: string) {
    setCandErrorById(prev => { const next = { ...prev }; delete next[id]; return next })
    setFindingId(id)
    const res = await fetch(`/api/admin/concierge/${id}/candidates`)
    setFindingId(null)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setCandErrorById(prev => ({ ...prev, [id]: data.error || 'Could not load candidates' }))
      return
    }
    setCandidatesById(prev => ({ ...prev, [id]: data.candidates || [] }))
  }

  async function updateStatus(id: string, status: string) {
    setErrorById(prev => { const next = { ...prev }; delete next[id]; return next })
    setProcessing(id)
    const res = await fetch(`/api/admin/concierge/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    setProcessing(null)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setErrorById(prev => ({ ...prev, [id]: data.error || 'Update failed' }))
      return
    }
    router.refresh()
  }

  if (requests.length === 0) {
    return <p className="text-slate-500 text-sm">No Concierge requests yet.</p>
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-6 space-y-5">
      {requests.map((req) => {
        const r = Array.isArray(req.requester) ? req.requester[0] : req.requester
        const name = r?.full_name || 'Unknown member'
        const email = r?.email || '—'
        const busy = processing === req.id
        return (
          <div key={req.id} className="pb-5 border-b border-slate-100 last:border-b-0 last:pb-0">
            <div className="flex items-start justify-between gap-4 mb-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">{name}</p>
                <p className="text-xs text-slate-500">{email}</p>
                <p className="text-xs text-slate-400 mt-0.5">Submitted {formatDate(req.created_at)}</p>
              </div>
              <Pill variant={statusVariant(req.status)}>{statusLabel(req.status)}</Pill>
            </div>

            <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2 mb-3">
              <Detail label="Looking to meet" value={req.target_person} />
              <Detail label="Role / title" value={req.target_role} />
              <Detail label="Company" value={req.target_company} />
              <Detail label="Industry" value={req.target_industry} />
            </dl>

            <div className="mb-2">
              <p className="text-xs font-medium text-slate-500">Why it's valuable</p>
              <p className="text-sm text-slate-800">{req.reason || <span className="text-slate-400">—</span>}</p>
            </div>

            {req.notes && (
              <div className="mb-2">
                <p className="text-xs font-medium text-slate-500">Notes</p>
                <p className="text-sm text-slate-800">{req.notes}</p>
              </div>
            )}

            <div className="flex flex-wrap gap-2 mt-3">
              {req.status !== 'closed' && (
                <button
                  onClick={() => findCandidates(req.id)}
                  disabled={findingId === req.id}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-brand-gold border border-brand-gold/40 bg-brand-gold-soft rounded-lg hover:bg-brand-gold/10 disabled:opacity-50 transition-colors"
                >
                  {findingId === req.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                  Find candidates
                </button>
              )}
              {req.status === 'pending' && (
                <button
                  onClick={() => updateStatus(req.id, 'reviewing')}
                  disabled={busy}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#1B2850] border border-[#1B2850]/30 rounded-lg hover:bg-[#1B2850]/5 disabled:opacity-50 transition-colors"
                >
                  {busy && <Loader2 className="w-3 h-3 animate-spin" />}
                  Start review
                </button>
              )}
              {req.status !== 'closed' && (
                <button
                  onClick={() => updateStatus(req.id, 'closed')}
                  disabled={busy}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors"
                >
                  {busy && <Loader2 className="w-3 h-3 animate-spin" />}
                  Close
                </button>
              )}
            </div>

            {errorById[req.id] && (
              <p className="text-xs text-red-600 mt-2">{errorById[req.id]}</p>
            )}
            {candErrorById[req.id] && (
              <p className="text-xs text-red-600 mt-2">{candErrorById[req.id]}</p>
            )}

            {candidatesById[req.id] && (
              <div className="mt-3 rounded-xl border border-brand-gold/20 bg-brand-cream/30 p-4">
                <p className="text-xs font-semibold text-brand-navy">Recommended candidates</p>
                <p className="text-[11px] text-slate-500 mb-3">
                  Best candidates for the requester&apos;s profile (not yet criteria-aware — does not filter on the typed target role/company/industry). Read-only — no introduction is created.
                </p>
                {candidatesById[req.id].length === 0 ? (
                  <p className="text-xs text-slate-500">No eligible candidates returned (small active pool after exclusions).</p>
                ) : (
                  <ol className="space-y-2.5">
                    {candidatesById[req.id].map((c, i) => (
                      <li key={c.id} className="flex items-start gap-3">
                        <span className="text-xs font-bold text-brand-gold mt-0.5 w-4 flex-shrink-0">{i + 1}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <p className="text-sm font-semibold text-slate-900">{c.name}</p>
                            <span className="text-[11px] font-semibold text-slate-500 flex-shrink-0">score {c.score}</span>
                          </div>
                          {(c.title || c.company) && (
                            <p className="text-xs text-slate-600">{[c.title, c.company].filter(Boolean).join(' · ')}</p>
                          )}
                          {c.reason && <p className="text-xs text-slate-500 mt-0.5">{c.reason}</p>}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
