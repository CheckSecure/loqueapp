import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifyManageToken } from '@/lib/referrals/manageToken'
import ManageInformationForm from '@/components/ManageInformationForm'

export const metadata = { title: 'Manage Your Information | Andrel' }
export const dynamic = 'force-dynamic'

/**
 * Nominee privacy page. This is a GET — it ONLY shows information and a
 * confirmation control. It performs NO deletion (deletion is POST-only), so an
 * email-security system that auto-fetches the link cannot remove anything.
 */
export default async function ManageInformationPage({
  searchParams,
}: {
  searchParams: { token?: string }
}) {
  const token = searchParams?.token || ''
  const waitlistId = verifyManageToken(token)

  let nominee: { full_name: string | null; email: string } | null = null
  if (waitlistId) {
    const admin = createAdminClient()
    const { data } = await admin
      .from('waitlist')
      .select('full_name, email')
      .eq('id', waitlistId)
      .maybeSingle()
    nominee = data ?? null
  }

  return (
    <div className="min-h-screen bg-[#F5F6FB] px-4 py-16">
      <div className="max-w-md mx-auto">
        <div className="text-center mb-8">
          <Link href="/" className="text-xl font-bold text-[#1B2850] tracking-tight block mb-6">Andrel</Link>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">Manage Your Information</h1>
        </div>

        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-8">
          {!waitlistId ? (
            <p className="text-sm text-slate-600">
              This link is invalid or has expired. If you have questions, email{' '}
              <a href="mailto:support@andrel.app" className="text-[#1B2850] underline">support@andrel.app</a>.
            </p>
          ) : !nominee ? (
            <p className="text-sm text-slate-600">
              Your information is no longer on file with Andrel. Nothing further is needed.
            </p>
          ) : (
            <div className="space-y-5">
              <p className="text-sm text-slate-600">
                A member of Andrel recommended you and shared the professional contact details below.
                Andrel is invitation-only and manually reviewed — you have not been added to any list
                automatically.
              </p>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
                <p className="font-semibold text-slate-900">{nominee.full_name || '—'}</p>
                <p className="text-slate-500">{nominee.email}</p>
              </div>
              <ManageInformationForm token={token} />
              <p className="text-xs text-slate-400">
                Questions? Email{' '}
                <a href="mailto:support@andrel.app" className="text-slate-500 underline">support@andrel.app</a>.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
