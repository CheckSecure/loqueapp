import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ADMIN_EMAIL } from '@/lib/matching/eligibility'
import { requestPasswordRecoveryForUserId } from '@/lib/auth/recoveryRequest'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/send-password-reset  { memberId }  — admin support tool.
 *
 * Triggers a real recovery EMAIL (via the same signInWithOtp mechanism the member flow
 * uses) to the member's CANONICAL auth.users email. It resolves identity from auth.users
 * directly, so it works for invited/never-signed-in members with no profiles row.
 *
 * Security: admin-only (ADMIN_EMAIL gate). The admin never sees or sets the member's
 * password, and the recovery token/link is NEVER returned to the browser — delivery is by
 * email only. The name is accurate: this SENDS the email (it does not merely generate a
 * link). Logs safe success/failure server-side.
 */
export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 401 })
  }

  let memberId = ''
  try {
    const body = await req.json().catch(() => ({}))
    memberId = typeof body?.memberId === 'string' ? body.memberId : ''
  } catch {
    memberId = ''
  }
  if (!memberId) return NextResponse.json({ error: 'Missing memberId' }, { status: 400 })

  const outcome = await requestPasswordRecoveryForUserId(memberId, 'admin')
  // Admin-only response: no enumeration concern, but still NEVER includes the token/link.
  return NextResponse.json({
    ok: outcome.ok,
    sent: outcome.sent,
    authUserFound: outcome.authUserFound,
    errorClass: outcome.errorClass ?? null,
  })
}
