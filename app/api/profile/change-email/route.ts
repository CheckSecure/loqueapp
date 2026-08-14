import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertSameOrigin } from '@/lib/http/sameOrigin'
import { normalizeEmail } from '@/lib/auth/normalizeEmail'

const NO_STORE = { 'Cache-Control': 'no-store' }

/**
 * POST /api/profile/change-email — reconcile the denormalized profiles.email mirror to the AUTHORITATIVE
 * Supabase Auth email.
 *
 * TRUST BOUNDARY: Supabase Auth owns the account email. The actual change (with its confirmation-link
 * verification) happens via supabase.auth.updateUser({email}) on the client and is NOT performed here.
 * This route only mirrors the ALREADY-EFFECTIVE auth email read from getUser() into profiles.email — so:
 *   - it accepts NO email (or any field) from the request body (a forged body is rejected);
 *   - the target row is ALWAYS the caller's own (id from getUser(), never a client-supplied UUID);
 *   - a pending/unverified new address is never mirrored (getUser().email stays the old address until the
 *     user confirms, at which point the /auth/callback mirror — and this route — write the new one);
 *   - service_role is used ONLY to write the mirror, never to bypass Auth's email-change verification.
 * Same-origin, authenticated, no-store. No-op when the mirror already matches. Errors are non-enumerating.
 */
export async function POST(req: Request) {
  const crossOrigin = assertSameOrigin(req)
  if (crossOrigin) return crossOrigin

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })

  // Reject any client-supplied parameters (arbitrary email, user id, etc.). This endpoint takes none.
  const ct = (req.headers.get('content-type') ?? '').toLowerCase()
  if (ct.includes('application/json')) {
    const body = await req.json().catch(() => ({}))
    if (body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length > 0) {
      return NextResponse.json({ error: 'This endpoint takes no parameters.' }, { status: 400, headers: NO_STORE })
    }
  }

  // Authoritative email = the session user's CURRENT (verified) auth email. Never a body value.
  const authEmail = normalizeEmail(user.email ?? '')
  if (!authEmail) return NextResponse.json({ error: 'No account email on file.' }, { status: 400, headers: NO_STORE })

  const admin = createAdminClient()
  const { data: current } = await admin.from('profiles').select('email').eq('id', user.id).maybeSingle()
  if (current && normalizeEmail(current.email ?? '') === authEmail) {
    return NextResponse.json({ success: true, updated: false }, { headers: NO_STORE }) // no-op / same email
  }

  const { error } = await admin.from('profiles').update({ email: authEmail, updated_at: new Date().toISOString() }).eq('id', user.id)
  if (error) {
    console.error('[profile/change-email] mirror_update_failed', error?.code || 'db_error')
    return NextResponse.json({ error: 'Could not update your email. Please try again.' }, { status: 500, headers: NO_STORE })
  }
  return NextResponse.json({ success: true, updated: true }, { headers: NO_STORE })
}
