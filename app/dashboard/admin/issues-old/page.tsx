import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, AlertCircle, ExternalLink } from 'lucide-react'
import { Pill } from '@/components/ui/Pill'

export const metadata = { title: 'Issue Reports | Admin' }
export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

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
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric'
  return d.toLocaleDateString('en-US', opts)
}

export default async function AdminIssuesPage() {
  const supabase = createClient()
  const userResult = await supabase.auth.getUser()
  const user = userResult.data.user
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  const admin = createAdminClient()
  const queryResult = await admin
    .from('issue_reports')
    .select('*')
    .order('created_at', { ascending: false })

  const reports = queryResult.data || []
  const error = queryResult.error
  let newCount = 0
  for (const r of reports) {
    if (r.status === 'new') newCount++
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/admin"
            className="text-sm text-slate-500 hover:text-slate-700 inline-flex items-center gap-1"
          >
            <ArrowLeft className="w-4 h-4" />
            Admin
          </Link>
        </div>

        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
              Issue Reports
            </h1>
            <p className="text-slate-500 text-sm mt-2">
              User-submitted bug reports and support questions. {newCount} new.
            </p>
          </div>
        </div>

        {error ? (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-sm text-red-700">
            Failed to load reports: {error.message}
          </div>
        ) : null}

        {reports.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-12 text-center">
            <div className="w-12 h-12 rounded-full bg-slate-50 flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-5 h-5 text-slate-400" />
            </div>
            <p className="text-base font-semibold text-slate-900 mb-1">No reports yet</p>
            <p className="text-sm text-slate-500 max-w-sm mx-auto leading-relaxed">
              When users submit bug reports or support questions, they will appear here.
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm divide-y divide-slate-100 overflow-hidden">
            {reports.map((report: any) => (
              <div key={report.id} className="px-6 py-5 hover:bg-slate-50 transition-colors">
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-900 truncate">
                      {report.user_email}
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {formatDate(report.created_at)}
                    </p>
                  </div>
                  <Pill variant={statusVariant(report.status)}>
                    {statusLabel(report.status)}
                  </Pill>
                </div>

                <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap mb-3">
                  {report.report_text}
                </p>

                {report.page_url ? (
                  
                    href={report.page_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-brand-navy transition-colors"
                  >
                    <ExternalLink className="w-3 h-3" />
                    {report.page_url}
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        )}

        <div className="bg-slate-100 rounded-2xl p-4 text-xs text-slate-500 leading-relaxed">
          <p className="font-medium text-slate-700 mb-1">Updating status</p>
          <p>
            Statuses are updated via SQL for now. Allowed values:{' '}
            <code className="bg-white px-1.5 py-0.5 rounded text-slate-700">new</code>,{' '}
            <code className="bg-white px-1.5 py-0.5 rounded text-slate-700">in_progress</code>,{' '}
            <code className="bg-white px-1.5 py-0.5 rounded text-slate-700">resolved</code>,{' '}
            <code className="bg-white px-1.5 py-0.5 rounded text-slate-700">wontfix</code>.
          </p>
        </div>
      </div>
    </div>
  )
}
