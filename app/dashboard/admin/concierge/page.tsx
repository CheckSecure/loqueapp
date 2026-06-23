import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { ADMIN_EMAIL } from '@/lib/admin/requireAdmin'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import AdminConciergeClient from '@/components/AdminConciergeClient'

export const metadata = { title: 'Concierge Queue | Admin' }
export const dynamic = 'force-dynamic'

export default async function AdminConciergePage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  // Admin-only — server-side gate via the shared ADMIN_EMAIL source of truth.
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  // Reads use the service-role admin client (same pattern as other admin pages),
  // joining the requester profile for name/email display.
  const admin = createAdminClient()
  const { data: requests } = await admin
    .from('concierge_requests')
    .select(
      'id, requester_id, target_person, target_role, target_company, ' +
      'target_industry, reason, notes, status, created_at, updated_at, ' +
      'requester:profiles!requester_id(full_name, email)'
    )
    .order('created_at', { ascending: false })

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <Link href="/dashboard/admin" className="text-sm text-slate-500 inline-flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" />
          Admin
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Concierge Queue</h1>
          <p className="text-sm text-slate-500 mt-1">Member-requested introductions awaiting triage.</p>
        </div>
        <AdminConciergeClient requests={(requests || []) as any} />
      </div>
    </div>
  )
}
