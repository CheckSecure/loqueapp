import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolvePasswordSetupMode, DEFAULT_MODE } from '@/lib/auth/passwordSetupCopy'

/**
 * Server-authorized COPY context for the password screens: is this member creating a
 * first password, recovering a forgotten one, or replacing a legacy temporary one?
 *
 * Returns ONLY `{ mode }` — 'create' | 'legacy' | 'reset', or the neutral 'unknown'
 * when it cannot be determined. No profile fields,
 * no email, no identifiers, no flags. The mode is derived from the caller's OWN
 * profile, read with the authenticated session via the self-only get_my_profile()
 * RPC (A3: authenticated SELECT on base public.profiles is revoked, so this must not
 * be a base-table read).
 *
 * SECURITY POSTURE — unchanged by this route:
 *   - It authorizes nothing and mutates nothing. It is a GET that only reads the
 *     caller's own row.
 *   - Unauthenticated → the neutral default mode, NOT an error and NOT a signal about
 *     whether any account exists. Enumeration-safe: every unauthenticated caller gets
 *     the identical response.
 *   - Token verification, the server-authorized password_reset_required clear, the
 *     continuation cookie, and the legacy dashboard gate are all untouched.
 */
export async function GET() {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()

    // No recovery/auth session → say nothing about any account; return the NEUTRAL mode
    // (not 'reset'), so an unauthenticated or failed lookup can never assert wrong wording.
    if (!user) return NextResponse.json({ mode: DEFAULT_MODE })

    // Self read via the A3 RPC. RETURNS TABLE → a SETOF of 0 or 1 self row; zero rows
    // is a CONFIRMED-absent profile (the expected pre-onboarding invitee state), never
    // an error — so it must not use .single().
    const { data: myRows, error } = await supabase.rpc('get_my_profile')
    if (error) return NextResponse.json({ mode: DEFAULT_MODE })

    const profile = Array.isArray(myRows) ? (myRows[0] ?? null) : (myRows ?? null)
    return NextResponse.json({ mode: resolvePasswordSetupMode({ profile }) })
  } catch {
    // Copy must never be the reason a password screen fails to render.
    return NextResponse.json({ mode: DEFAULT_MODE })
  }
}
