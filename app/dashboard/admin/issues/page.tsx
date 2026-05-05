import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import AdminIssuesClient from '@/components/AdminIssuesClient'

export const metadata = { title: 'Issue Reports | Admin' }
export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export default async function AdminIssuesPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  const admin = createAdminClient()
  const { data: reports } = await admin
    .from('issue_reports')
    .select('id, user_id, user_email, report_text, page_url, status, created_at, conversation_id')
    .order('created_at', { ascending: false })

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <Link href="/dashboard/admin" className="text-sm text-slate-500 inline-flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" />
          Admin
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">Issue Reports</h1>
        <AdminIssuesClient reports={reports || []} />
      </div>
    </div>
  )
}
