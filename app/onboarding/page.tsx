import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import OnboardingForm from '@/components/OnboardingForm'
import { pickOnboardingPrefillName } from '@/lib/validation/fullName'
import { resolveOnboardingGate } from '@/lib/onboarding/steps'
import { verifyContinuationToken, CONTINUATION_COOKIE } from '@/lib/auth/resetContinuation'

export const metadata = { title: 'Complete your profile | Andrel' }

// FAIL-CLOSED error state: a profile lookup that errors or is ambiguous must NOT render onboarding
// as password-complete. We show a safe, authenticated retry — never the password form.
function OnboardingUnavailable() {
  return (
    <div className="min-h-screen bg-[#F5F6FB] flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-slate-100 p-8 text-center space-y-4">
        <h1 className="text-xl font-bold text-slate-900">We couldn’t load your account</h1>
        <p className="text-sm text-slate-600">Something went wrong preparing your onboarding. Please try again in a moment.</p>
        <div className="flex items-center justify-center gap-4 pt-1">
          <Link href="/onboarding" className="text-sm font-semibold text-[#1B2850] hover:underline">Try again</Link>
          <Link href="/login" className="text-sm font-semibold text-slate-500 hover:underline">Sign in</Link>
        </div>
      </div>
    </div>
  )
}

export default async function OnboardingPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // maybeSingle → distinguish a CONFIRMED absent profile (null, no error) from a DB/permission error.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('profile_complete, full_name, password_reset_required')
    .eq('id', user.id)
    .maybeSingle()

  // Server-authorized evidence that the password was just set (e.g. the onboarding password step's
  // flag-clear was deferred): a valid, signed, user-bound continuation cookie. Never a client marker.
  const contToken = cookies().get(CONTINUATION_COOKIE)?.value
  const passwordAlreadySet = verifyContinuationToken(contToken, user.id, Date.now())

  const gate = resolveOnboardingGate({ profile, error: profileError, passwordAlreadySet })
  if (gate.kind === 'complete') redirect('/dashboard/introductions')
  if (gate.kind === 'error') return <OnboardingUnavailable /> // FAIL CLOSED — no password form

  // Prefill the name field: existing valid profile name → valid waitlist name (the name they were
  // invited under) → blank. Prefill only; the member can still edit it.
  let waitlistName: string | null = null
  if (user.email) {
    const { data: wl } = await createAdminClient()
      .from('waitlist')
      .select('full_name')
      .ilike('email', user.email)
      .maybeSingle()
    waitlistName = (wl as { full_name: string | null } | null)?.full_name ?? null
  }
  const initialFullName = pickOnboardingPrefillName(profile?.full_name ?? null, waitlistName)

  return <OnboardingForm initialFullName={initialFullName} needsPassword={gate.needsPassword} />
}
