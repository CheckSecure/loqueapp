import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { needsReacceptance } from '@/lib/legal/terms'
import AcceptTermsForm from '@/components/legal/AcceptTermsForm'

export const metadata = { title: 'Review & Accept | Andrel' }
export const dynamic = 'force-dynamic'

/**
 * Clickwrap gate. Authenticated members whose accepted Terms/Privacy versions are
 * missing or below the current versions land here (redirected by the dashboard
 * layout) and must affirmatively accept before returning to the platform. If the
 * acceptance columns aren't migrated yet the check fails open and the member is
 * sent straight through (compatibility mode; see migration 025).
 */
export default async function LegalAcceptPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Already current? Don't force acceptance again. Fail open on missing columns.
  let mustAccept = true
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('terms_version_accepted, privacy_version_accepted')
      .eq('id', user.id)
      .single()
    if (error) mustAccept = false // columns absent / query failed → don't block
    else mustAccept = needsReacceptance(data?.terms_version_accepted, data?.privacy_version_accepted)
  } catch {
    mustAccept = false
  }
  if (!mustAccept) redirect('/dashboard')

  return (
    <div className="min-h-screen bg-[#F5F6FB] px-4 py-16">
      <div className="max-w-md mx-auto">
        <div className="text-center mb-8">
          <Link href="/" className="text-xl font-bold text-[#1B2850] tracking-tight block mb-6">Andrel</Link>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">Before you continue</h1>
          <p className="text-slate-500 text-sm">
            We&apos;ve updated our legal terms. Please review and accept them to continue using Andrel.
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-8">
          <AcceptTermsForm redirectTo="/dashboard" />
        </div>
      </div>
    </div>
  )
}
