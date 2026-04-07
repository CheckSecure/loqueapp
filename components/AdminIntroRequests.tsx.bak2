'use client'

import { useState } from 'react'
import { adminApproveIntro, adminRejectIntro } from '@/app/actions'
import { Loader2, CheckCircle, XCircle, Clock, Link2, AlertCircle, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface RequestRow {
  id: string
  status: string
  note: string | null
  created_at: string
  requester: { id?: string; full_name: string | null; title: string | null; company: string | null; role_type: string | null } | null
  target:    { id?: string; full_name: string | null; title: string | null; company: string | null; role_type: string | null } | null
}

const STATUS_CFG: Record<string, { label: string; cls: string; Icon: any }> = {
  pending:                  { label: 'Pending',          cls: 'bg-amber-50 text-amber-700 border-amber-200',   Icon: Clock },
  approved:                 { label: 'Approved',         cls: 'bg-green-50 text-green-700 border-green-200',   Icon: CheckCircle },
  rejected:                 { label: 'Rejected',         cls: 'bg-slate-50 text-slate-500 border-slate-200',   Icon: XCircle },
  accepted:                 { label: 'Connected',        cls: 'bg-blue-50 text-blue-700 border-blue-200',      Icon: Link2 },
  accepted_pending_payment: { label: 'Awaiting payment', cls: 'bg-orange-50 text-orange-700 border-orange-200', Icon: AlertCircle },
  declined:                 { label: 'Declined',         cls: 'bg-red-50 text-red-600 border-red-200',         Icon: XCircle },
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CFG[status] ?? { label: status, cls: 'bg-slate-50 text-slate-500 border-slate-200', Icon: Clock }
  return (
    <span className={cn('inline-flex items-center gap-1 text-[11px] font-semibold border px-2 py-0.5 rounded-full whitespace-nowrap', cfg.cls)}>
      <cfg.Icon className="w-3 h-3" />
      {cfg.label}
    </span>
  )
}

function PersonCell({ p }: { p: RequestRow['requester'] }) {
  if (!p) return <span className="text-xs text-slate-400">Unknown</span>
  const subtitle = [p.title || p.role_type?.replace(/_/g, ' '), p.company].filter(Boolean).join(' · ')
  return (
    <div>
      <p className="text-sm font-semibold text-slate-900 leading-tight">{p.full_name || '—'}</p>
      {subtitle && <p className="text-xs text-slate-400 mt-0.5 leading-tight">{subtitle}</p>}
    </div>
  )
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function AdminIntroRequests({ initial }: { initial: RequestRow[] }) {
  const [rows, setRows] = useState(initial)
  const [loading, setLoading] = useState<Record<string, 'approve' | 'reject'>>({})

  const handle = async (id: string, action: 'approve' | 'reject') => {
    setLoading(prev => ({ ...prev, [id]: action }))
    const result = action === 'approve'
      ? await adminApproveIntro(id)
      : await adminRejectIntro(id)
    setLoading(prev => { const n = { ...prev }; delete n[id]; return n })
    if (!result.error) {
      const newStatus = action === 'approve'
        ? ((result as any).status ?? 'approved')
        : 'rejected'
      setRows(prev => prev.map(r => r.id === id ? { ...r, status: newStatus } : r))
    }
  }

  if (rows.length === 0) {
    return (
      <div className="bg-white border border-slate-100 rounded-xl p-10 text-center shadow-sm">
        <Clock className="w-8 h-8 text-slate-300 mx-auto mb-3" />
        <p className="text-sm font-semibold text-slate-700">No intro requests yet</p>
        <p className="text-xs text-slate-400 mt-1">Requests will appear here as members send them.</p>
      </div>
    )
  }

  const pending = rows.filter(r => r.status === 'pending')
  const reviewed = rows.filter(r => r.status !== 'pending')

  const TableSection = ({ items, title }: { items: RequestRow[]; title: string }) => (
    <div>
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
        {title} · {items.length}
      </p>
      <div className="bg-white border border-slate-100 rounded-xl shadow-sm overflow-hidden">
      <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[960px]">
              <tr className="border-b border-slate-100 bg-[#F5F6FB]">
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Requester</th>
                <th className="px-2 py-3 w-6" />
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Target</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Note</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Submitted</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Status</th>
                <th className="px-5 py-3 w-44" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map(row => {
                const busy = loading[row.id]
                const isPending = row.status === 'pending'
                return (
                  <tr key={row.id} className="hover:bg-[#F5F6FB] transition-colors align-top">
                    <td className="px-5 py-4"><PersonCell p={row.requester} /></td>
                    <td className="px-2 py-4 text-slate-300"><ArrowRight className="w-3.5 h-3.5" /></td>
                    <td className="px-5 py-4"><PersonCell p={row.target} /></td>
                    <td className="px-5 py-4 max-w-[200px]">
                      {row.note
                        ? <p className="text-xs text-slate-500 italic line-clamp-3 leading-relaxed">"{row.note}"</p>
                        : <span className="text-xs text-slate-300">No note</span>}
                    </td>
                    <td className="px-5 py-4 text-xs text-slate-400 whitespace-nowrap">{formatDate(row.created_at)}</td>
                    <td className="px-5 py-4"><StatusBadge status={row.status} /></td>
                    <td className="px-5 py-4">
                      {isPending && (
                        <div className="flex items-center gap-2 justify-end">
                          <button
                            disabled={!!busy}
                            onClick={() => handle(row.id, 'approve')}
                            className="flex items-center gap-1.5 text-xs font-semibold text-white bg-[#1B2850] hover:bg-[#2E4080] px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60 whitespace-nowrap"
                          >
                            {busy === 'approve' ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                            Approve
                          </button>
                          <button
                            disabled={!!busy}
                            onClick={() => handle(row.id, 'reject')}
                            className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 border border-slate-200 hover:text-red-600 hover:border-red-200 hover:bg-red-50 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60 whitespace-nowrap"
                          >
                            {busy === 'reject' ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
                            Reject
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )

  return (
    <div className="space-y-8">
      {pending.length > 0 && <TableSection items={pending} title="Awaiting decision" />}
      {reviewed.length > 0 && <TableSection items={reviewed} title="Previously reviewed" />}
    </div>
  )
}
