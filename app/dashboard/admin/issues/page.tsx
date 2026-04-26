import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
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
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  const admin = createAdminClient()
  const queryResult = await admin
    .from('issue_reports')
    .select('*')
    .order('created_at', { ascending: false })

  const reports = queryResult.data || []

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <Link href="/dashboard/admin" className="text-sm text-slate-500 inline-flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" />
          Admin
        </Link>

        <h1 className="text-2xl font-bold text-slate-900">Issue Reports</h1>

        {reports.length === 0 ? (
          <p>No reports yet.</p>
        ) : (
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
                <p className="text-sm text-slate-700 mb-2">{report.report_text}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
