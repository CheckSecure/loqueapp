import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { TERMS_VERSION, PRIVACY_VERSION } from '@/lib/legal/terms'

/**
 * The single authoritative writer for clickwrap legal acceptance.
 *
 * Records the member's affirmative acceptance of the CURRENT Terms of Service and
 * Privacy Policy versions (from lib/legal/terms.ts), the acceptance timestamp, and
 * the request IP when available. Server-enforced: it refuses to record anything
 * unless the client affirmatively accepted BOTH documents, so a partial or
 * bypassed acceptance can never be stored.
 */
export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: any = {}
  try { body = await request.json() } catch { /* empty body → treated as non-acceptance below */ }

  // Clickwrap: both boxes must be affirmatively checked. No optional acceptance.
  if (body?.acceptTerms !== true || body?.acceptPrivacy !== true) {
    return NextResponse.json(
      { error: 'You must accept both the Terms of Service and the Privacy Policy to continue.' },
      { status: 400 },
    )
  }

  // Reuse the existing IP idiom (app/api/metrics/route.ts). Best-effort/audit only —
  // stored only because the request already carries it; no new infrastructure.
  const ip = (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null
  const now = new Date().toISOString()

  const admin = createAdminClient()
  const { error } = await admin
    .from('profiles')
    .update({
      terms_version_accepted: TERMS_VERSION,
      terms_accepted_at: now,
      privacy_version_accepted: PRIVACY_VERSION,
      privacy_accepted_at: now,
      legal_accepted_ip: ip,
    })
    .eq('id', user.id)

  if (error) {
    console.error('[legal/accept] update failed:', error.message)
    return NextResponse.json({ error: 'Could not record your acceptance. Please try again.' }, { status: 500 })
  }

  console.log(`[legal/accept] recorded userId=${user.id} terms=v${TERMS_VERSION} privacy=v${PRIVACY_VERSION}`)
  return NextResponse.json({ success: true })
}
