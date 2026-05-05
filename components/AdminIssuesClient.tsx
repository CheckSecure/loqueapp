'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Pill } from '@/components/ui/Pill'
import { Loader2 } from 'lucide-react'

interface IssueReport {
  id: string
  user_id: string
  user_email: string
  report_text: string
  page_url: string | null
  status: string
  created_at: string
  conversation_id: string | null
}

function statusVariant(status: string): 'gold' | 'navy' | 'success' | 'default' {
  if (status === 'new') return 'gold'
  if (status === 'in_progress') return 'navy'
  if (status === 'resolved') return 'success'
  return 'default'
}

function statusLabel(status: string): string {
  if (status === 'new') return 'New'
  if (status === 'in_progress') return 'In progress'
  if (status === 'resolved') return 'Resolved'
  if (status === 'wontfix') return "Won't fix"
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

export default function AdminIssuesClient({ reports }: { reports: IssueReport[] }) {
  const router = useRouter()
  const [processing, setProcessing] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [errorByReportId, setErrorByReportId] = useState<Record<string, string>>({})

  function clearError(id: string) {
    setErrorByReportId(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  async function updateStatus(id: string, status: string) {
    clearError(id)
    setProcessing(id)
    await fetch(`/api/admin/issues/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    setProcessing(null)
    router.refresh()
  }

  async function deleteReport(id: string) {
    clearError(id)
    setProcessing(id)
    await fetch(`/api/admin/issues/${id}`, { method: 'DELETE' })
    setProcessing(null)
    setConfirmDeleteId(null)
    router.refresh()
  }

  if (reports.length === 0) {
    return <p className="text-slate-500 text-sm">No reports yet.</p>
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-6 space-y-4">
      {reports.map((report) => (
        <div key={report.id} className="pb-4 border-b border-slate-100 last:border-b-0 last:pb-0">
          <div className="flex items-start justify-between gap-4 mb-2">
            <div>
              <p className="text-sm font-semibold text-slate-900">{report.user_email}</p>
              <p className="text-xs text-slate-400 mt-0.5">{formatDate(report.created_at)}</p>
            </div>
            <Pill variant={statusVariant(report.status)}>
              {statusLabel(report.status)}
            </Pill>
          </div>

          <p className="text-sm text-slate-700 mb-3">{report.report_text}</p>

          {confirmDeleteId === report.id ? (
            <div className="p-3 bg-red-50 border border-red-200 rounded-xl space-y-2">
              <p className="text-sm font-semibold text-red-700">Delete this report? This cannot be undone.</p>
              <div className="flex gap-2">
                <button
                  onClick={() => { setConfirmDeleteId(null); clearError(report.id) }}
                  className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => deleteReport(report.id)}
                  disabled={processing === report.id}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
                >
                  {processing === report.id && <Loader2 className="w-3 h-3 animate-spin" />}
                  Delete
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {report.status !== 'resolved' && (
                  <button
                    onClick={() => updateStatus(report.id, 'resolved')}
                    disabled={processing === report.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-green-700 border border-green-200 bg-green-50 rounded-lg hover:bg-green-100 disabled:opacity-50 transition-colors"
                  >
                    {processing === report.id && <Loader2 className="w-3 h-3 animate-spin" />}
                    Mark Resolved
                  </button>
                )}
                {report.status !== 'wontfix' && (
                  <button
                    onClick={() => updateStatus(report.id, 'wontfix')}
                    disabled={processing === report.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors"
                  >
                    {processing === report.id && <Loader2 className="w-3 h-3 animate-spin" />}
                    Won't Fix
                  </button>
                )}
                <button
                  onClick={() => { clearError(report.id); setConfirmDeleteId(report.id) }}
                  disabled={processing === report.id}
                  className="px-3 py-1.5 text-xs font-semibold text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors"
                >
                  Delete
                </button>
              </div>
              {errorByReportId[report.id] && (
                <p className="text-xs text-red-600 mt-2">{errorByReportId[report.id]}</p>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  )
}
