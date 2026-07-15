'use client'

import { useState } from 'react'
import { professionalIdentityLine } from '@/lib/professionalIdentity'
import { useRouter } from 'next/navigation'
import { Pill } from '@/components/ui/Pill'
import { Loader2, Search, Sparkles, CheckCircle2 } from 'lucide-react'

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
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</dt>
      <dd className="text-sm text-slate-800 mt-0.5">{value || <span className="text-slate-300">—</span>}</dd>
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

  // Create Andrel Intro — per-candidate, with inline confirm.
  const [confirmKey, setConfirmKey] = useState<string | null>(null) // `${reqId}:${candId}`
  const [introducingKey, setIntroducingKey] = useState<string | null>(null)
  const [introducedById, setIntroducedById] = useState<Record<string, boolean>>({})
  const [introMsgById, setIntroMsgById] = useState<Record<string, string>>({})
  const [introErrById, setIntroErrById] = useState<Record<string, string>>({})

  async function introduce(reqId: string, candidate: Candidate) {
    const key = `${reqId}:${candidate.id}`
    setIntroErrById(prev => { const next = { ...prev }; delete next[reqId]; return next })
    setIntroducingKey(key)
    const res = await fetch(`/api/admin/concierge/${reqId}/introduce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidate_id: candidate.id, match_reason: candidate.reason || undefined }),
    })
    setIntroducingKey(null)
    setConfirmKey(null)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setIntroErrById(prev => ({ ...prev, [reqId]: data.error || 'Failed to create introduction' }))
      return
    }
    setIntroducedById(prev => ({ ...prev, [reqId]: true }))
    setIntroMsgById(prev => ({
      ...prev,
      [reqId]: 'Andrel introduction created — both members notified and will see it on their Introductions page.',
    }))
    router.refresh()
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
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-12 text-center">
        <p className="text-sm text-slate-500">No Concierge requests yet.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {requests.map((req) => {
        const r = Array.isArray(req.requester) ? req.requester[0] : req.requester
        const name = r?.full_name || 'Unknown member'
        const email = r?.email || '—'
        const busy = processing === req.id
        const isIntroduced = req.status === 'introduced' || introducedById[req.id]
        return (
          <div
            key={req.id}
            className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.18em] text-brand-gold">
                  <Sparkles className="w-3 h-3" />
                  Andrel Concierge
                </span>
                <p className="text-base font-semibold text-brand-navy leading-tight mt-1.5 truncate">{name}</p>
                <p className="text-xs text-slate-500 mt-0.5 truncate">{email}</p>
              </div>
              <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                <Pill variant={statusVariant(req.status)} dot>{statusLabel(req.status)}</Pill>
                <span className="text-[11px] text-slate-400">Submitted {formatDate(req.created_at)}</span>
              </div>
            </div>

            {/* Request details */}
            <dl className="mt-6 grid sm:grid-cols-2 gap-x-8 gap-y-3.5">
              <Detail label="Looking to meet" value={req.target_person} />
              <Detail label="Role / title" value={req.target_role} />
              <Detail label="Company" value={req.target_company} />
              <Detail label="Industry" value={req.target_industry} />
            </dl>

            <div className="mt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Why it&apos;s valuable</p>
              <p className="text-sm text-slate-700 leading-relaxed">{req.reason || <span className="text-slate-300">—</span>}</p>
            </div>

            {req.notes && (
              <div className="mt-4">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Notes</p>
                <p className="text-sm text-slate-700 leading-relaxed">{req.notes}</p>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-2 mt-5">
              {req.status !== 'closed' && !isIntroduced && (
                <button
                  onClick={() => findCandidates(req.id)}
                  disabled={findingId === req.id}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-brand-gold border border-brand-gold/40 bg-brand-gold-soft rounded-lg hover:bg-brand-gold/10 disabled:opacity-50 transition-colors"
                >
                  {findingId === req.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                  Find candidates
                </button>
              )}
              {req.status === 'pending' && (
                <button
                  onClick={() => updateStatus(req.id, 'reviewing')}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-brand-navy border border-brand-navy/25 rounded-lg hover:bg-brand-navy/5 disabled:opacity-50 transition-colors"
                >
                  {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Start review
                </button>
              )}
              {req.status !== 'closed' && (
                <button
                  onClick={() => updateStatus(req.id, 'closed')}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors"
                >
                  {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Close
                </button>
              )}
            </div>

            {errorById[req.id] && (
              <p className="text-xs text-red-600 mt-3">{errorById[req.id]}</p>
            )}
            {candErrorById[req.id] && (
              <p className="text-xs text-red-600 mt-3">{candErrorById[req.id]}</p>
            )}
            {introErrById[req.id] && (
              <p className="text-xs text-red-600 mt-3">{introErrById[req.id]}</p>
            )}
            {introMsgById[req.id] && (
              <p className="flex items-start gap-1.5 text-xs text-emerald-700 mt-3 rounded-lg bg-emerald-50 border border-emerald-100 px-3 py-2">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-px" />
                {introMsgById[req.id]}
              </p>
            )}

            {candidatesById[req.id] && (
              <div className="mt-5 rounded-xl border border-brand-gold/20 bg-brand-cream/40 p-5">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-brand-gold" />
                  <p className="text-[11px] font-bold uppercase tracking-wider text-brand-navy">Recommended candidates</p>
                </div>
                <p className="text-[11px] text-slate-500 mt-1 mb-4 leading-relaxed">
                  Best candidates for the requester&apos;s profile (not yet criteria-aware — does not filter on the typed target role/company/industry). Read-only — no introduction is created.
                </p>
                {candidatesById[req.id].length === 0 ? (
                  <p className="text-xs text-slate-500">No eligible candidates returned (small active pool after exclusions).</p>
                ) : (
                  <ol className="space-y-3">
                    {candidatesById[req.id].map((c, i) => (
                      <li key={c.id} className="rounded-lg border border-slate-200/70 bg-white p-4">
                        <div className="flex items-start gap-3">
                          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-brand-gold-soft text-brand-gold text-xs font-bold flex-shrink-0">{i + 1}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-slate-900 truncate">{c.name}</p>
                                {(c.title || c.company) && (
                                  <p className="text-xs text-slate-500 mt-0.5 truncate">{professionalIdentityLine(c)}</p>
                                )}
                              </div>
                              <div className="flex flex-col items-center leading-none flex-shrink-0 rounded-md bg-brand-navy/[0.04] border border-brand-navy/10 px-2.5 py-1">
                                <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Score</span>
                                <span className="text-sm font-bold text-brand-navy mt-0.5">{c.score}</span>
                              </div>
                            </div>
                            {c.reason && <p className="text-xs text-slate-600 mt-2 leading-relaxed">{c.reason}</p>}

                            {!isIntroduced && (
                              confirmKey === `${req.id}:${c.id}` ? (
                                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand-navy/15 bg-brand-navy/[0.03] px-3 py-2">
                                  <span className="text-[11px] text-slate-600">Create Andrel intro with <span className="font-semibold text-slate-800">{c.name}</span>?</span>
                                  <button
                                    onClick={() => introduce(req.id, c)}
                                    disabled={introducingKey === `${req.id}:${c.id}`}
                                    className="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-semibold text-white bg-brand-navy rounded-md hover:bg-brand-navy/90 disabled:opacity-50 transition-colors"
                                  >
                                    {introducingKey === `${req.id}:${c.id}` && <Loader2 className="w-3 h-3 animate-spin" />}
                                    Confirm
                                  </button>
                                  <button
                                    onClick={() => setConfirmKey(null)}
                                    className="px-2.5 py-1.5 text-[11px] font-medium text-slate-500 hover:text-slate-800 transition-colors"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setConfirmKey(`${req.id}:${c.id}`)}
                                  className="mt-3 inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-brand-navy rounded-lg hover:bg-brand-navy/90 shadow-sm transition-colors"
                                >
                                  <Sparkles className="w-3.5 h-3.5 text-brand-gold" />
                                  Create Andrel Intro
                                </button>
                              )
                            )}
                          </div>
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
