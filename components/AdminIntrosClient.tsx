'use client'

import { useState } from 'react'
import { professionalIdentityLine } from '@/lib/professionalIdentity'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { CheckCircle, XCircle, Clock, Sparkles, Network, Archive, ShieldQuestion } from 'lucide-react'
import { adminRejectIntro } from '@/app/actions'
import type { BucketedPage, BucketedRow } from '@/lib/introRequests/classify'

function fmt(ts: string) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function Pair({ row }: { row: BucketedRow }) {
  return (
    <div className="flex items-center gap-4 mb-2">
      <div>
        <p className="text-sm font-semibold text-slate-900">{row.requester?.full_name || 'Unknown'}</p>
        <p className="text-xs text-slate-500">{professionalIdentityLine(row.requester)}</p>
      </div>
      <span className="text-slate-400">→</span>
      <div>
        <p className="text-sm font-semibold text-slate-900">{row.target?.full_name || 'Unknown'}</p>
        <p className="text-xs text-slate-500">{professionalIdentityLine(row.target)}</p>
      </div>
    </div>
  )
}

function Stat({ label, value, sub, href }: { label: string; value: number; sub?: string; href?: string }) {
  const inner = (
    <div className="bg-white rounded-xl border border-slate-200 p-4 h-full">
      <p className="text-2xl font-bold text-slate-900 leading-none">{value}</p>
      <p className="text-[11px] text-slate-500 mt-1.5 leading-tight">{label}</p>
      {sub && <p className="text-[11px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  )
  return href ? <Link href={href} className="block hover:opacity-90 transition-opacity">{inner}</Link> : inner
}

export default function AdminIntrosClient({ bucketed }: { bucketed: BucketedPage }) {
  const router = useRouter()
  const [processing, setProcessing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { needsReview, reciprocalLive, legacy, counts } = bucketed

  const handleReject = async (id: string) => {
    setProcessing(id); setError(null)
    const res: any = await adminRejectIntro(id)
    if (res?.error) setError(res.error)
    router.refresh(); setProcessing(null)
  }

  const legacyExplanation = (row: BucketedRow) =>
    row.status === 'pending'
      ? 'Legacy one-sided request — no action taken. This cannot be approved because the other member has not consented.'
      : 'Legacy record — read-only history.'

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Intro Requests</h1>
          <p className="text-sm text-slate-500 mt-1">Reciprocal introductions connect automatically on mutual interest. Counts are unique member pairs.</p>
        </div>

        {error && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">{error}</div>
        )}

        {/* Summary — unique pairs (directional rows shown only as secondary diagnostics) */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Connections (unique pairs)" value={counts.connections} href="/dashboard/admin/match-inspector" />
          <Stat label="Reciprocal suggestions (pairs)" value={counts.reciprocalPairs} sub={`${counts.reciprocalRows} directional rows`} />
          <Stat label="Needs review (pairs)" value={counts.needsReviewPairs} />
          <Stat label="Legacy history (pairs)" value={counts.legacyPairs} sub={`${counts.legacyRows} rows`} />
        </div>

        {/* 1 ── NEEDS REVIEW (admin/concierge + flagged; the only actionable lane) ───────── */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <ShieldQuestion className="w-4 h-4 text-slate-500" />
            <h2 className="text-sm font-semibold text-slate-700">Needs review</h2>
            <span className="text-[11px] text-slate-400">admin / concierge / flagged — review &amp; cancel only (members finalize by accepting)</span>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
            {needsReview.length === 0 ? (
              <p className="px-4 py-4 text-sm text-slate-500">Nothing awaiting review.</p>
            ) : needsReview.map((row) => (
              <div key={row.id} className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <Pair row={row} />
                    <span className="inline-block px-2 py-0.5 rounded bg-indigo-100 text-indigo-700 text-[11px] font-semibold">
                      {row.category === 'flagged_review' ? 'Flagged' : 'Admin / concierge'}
                    </span>
                    {row.note && <p className="text-xs text-slate-600 bg-slate-50 rounded px-3 py-2 border border-slate-200 mt-2">&ldquo;{row.note}&rdquo;</p>}
                    <p className="text-xs text-slate-400 mt-2">{fmt(row.created_at)}</p>
                  </div>
                  <div className="flex gap-2">
                    {/* No Approve: an admin can propose/facilitate but can never supply either member's
                        consent. Both members finalize by independently accepting. Admin may cancel/archive. */}
                    <button onClick={() => handleReject(row.id)} disabled={processing === row.id}
                      className="px-4 py-2 bg-white border border-slate-300 text-slate-700 text-sm font-semibold rounded-lg hover:bg-slate-50 disabled:opacity-50">
                      {processing === row.id ? 'Working…' : 'Cancel intro'}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-400 mt-1.5">Admins cannot approve a connection. Both members must independently accept — this finalizes automatically once each expresses interest.</p>
        </section>

        {/* 2 ── RECIPROCAL SUGGESTIONS (read-only, deduped by pair) ──────────────────────── */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-4 h-4 text-slate-500" />
            <h2 className="text-sm font-semibold text-slate-700">Reciprocal suggestions</h2>
            <span className="text-[11px] text-slate-400">read-only · both members see the card · connects automatically on mutual interest</span>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
            {reciprocalLive.length === 0 ? (
              <p className="px-4 py-4 text-sm text-slate-500">No live reciprocal suggestions.</p>
            ) : reciprocalLive.map((row) => (
              <div key={row.id} className="p-4 flex items-center justify-between gap-4">
                <Pair row={row} />
                <span className="px-2 py-1 bg-blue-100 text-blue-700 text-[11px] font-semibold rounded whitespace-nowrap">Auto — no approval</span>
              </div>
            ))}
          </div>
        </section>

        {/* 3 ── CONNECTIONS (unique matched pairs) ───────────────────────────────────────── */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <Network className="w-4 h-4 text-slate-500" />
            <h2 className="text-sm font-semibold text-slate-700">Connections</h2>
            <span className="text-[11px] text-slate-400">unique matched pairs</span>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-between">
            <p className="text-sm text-slate-700"><span className="font-bold">{counts.connections}</span> connected pairs</p>
            <Link href="/dashboard/admin/match-inspector" className="text-xs text-[#1B2850] font-medium">Inspect pairs →</Link>
          </div>
        </section>

        {/* 4 ── LEGACY HISTORY (read-only) ───────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <Archive className="w-4 h-4 text-slate-500" />
            <h2 className="text-sm font-semibold text-slate-700">Legacy history</h2>
            <span className="text-[11px] text-slate-400">read-only — pre-reciprocal records, never approvable</span>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
            {legacy.length === 0 ? (
              <p className="px-4 py-4 text-sm text-slate-500">No legacy records.</p>
            ) : legacy.map((row) => (
              <div key={row.id} className="p-4">
                <Pair row={row} />
                <div className="flex items-center gap-2 mt-1">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-[11px] font-semibold">
                    <Clock className="w-3 h-3" /> {row.status}
                  </span>
                  <span className="text-[11px] text-slate-500">{legacyExplanation(row)}</span>
                </div>
                <p className="text-xs text-slate-400 mt-2">{fmt(row.created_at)}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
