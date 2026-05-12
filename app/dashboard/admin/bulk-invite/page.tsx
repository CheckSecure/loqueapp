import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import BulkInviteClient from '@/components/admin/BulkInviteClient'

export const metadata = { title: 'Bulk Invite | Admin' }

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export default async function BulkInvitePage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Bulk Invite</h1>
          <p className="text-sm text-slate-500 mt-1">
            Paste and send curated invites to the launch cohort. Up to 100 per batch.
            One-off invites use <a href="/dashboard/admin/waitlist" className="underline hover:text-slate-700">Waitlist</a>.
          </p>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
          <strong>Email-first ordering:</strong> each invite sends the email before creating the auth account.
          If Resend fails for a row, no orphan auth user is created — that row appears as{' '}
          <code className="bg-amber-100 px-1 rounded">email_failed</code> in the result and can be retried safely.
        </div>

        <BulkInviteClient />
      </div>
    </div>
  )
}
