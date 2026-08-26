import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import OnboardingForm from '@/components/OnboardingForm'
// This route requires a session (see the !user redirect below), so the wordmark destination is
// resolved here on the server rather than guessed in the browser.
import { AUTHENTICATED_LOGO_HREF } from '@/lib/nav/logoHref'
import { pickOnboardingPrefillName } from '@/lib/validation/fullName'
import { resolveOnboardingGate, selfProfileFromRpc, type OnboardingProfileLite } from '@/lib/onboarding/steps'
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

  // A3: read the caller's OWN gate fields via the self-only get_my_profile() RPC — authenticated
  // SELECT on the base profiles table is REVOKED (migration 058), so a direct base-table read here
  // fails with permission-denied for a valid confirmed invitee and gets mis-rendered as "couldn't load
  // your account". get_my_profile() RETURNS TABLE → a SETOF (array of 0 or 1 self row). ZERO rows is a
  // CONFIRMED-absent profile (the expected pre-onboarding invitee state), NOT an error — selfProfileFromRpc
  // encodes that contract (never use .single(), which would PGRST116-error on no rows). A genuine
  // RPC/permission/auth failure sets `profileError` → the gate fails closed to a retryable error.
  const { data: myRows, error: profileError } = await supabase.rpc('get_my_profile')
  const profile = selfProfileFromRpc<OnboardingProfileLite>(myRows as any)

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

  return <OnboardingForm initialFullName={initialFullName} needsPassword={gate.needsPassword} logoHref={AUTHENTICATED_LOGO_HREF} />
}
