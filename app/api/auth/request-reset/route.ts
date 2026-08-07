import { NextResponse } from 'next/server'
import { requestPasswordRecovery } from '@/lib/auth/recoveryRequest'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/request-reset — the member-facing password-reset request.
 *
 * Normalizes the email server-side, resolves the CANONICAL auth.users email, and (only if
 * a user exists) sends a recovery magic-link via the scanner-hardened /auth/recover flow.
 * ALWAYS returns the same generic response regardless of whether an account exists — no
 * account enumeration, no auth-user details, no token/link. Provider rate-limits/errors are
 * NOT surfaced to the caller (the client's own 60s cooldown handles pacing). A genuine
 * server fault returns ok:false so the client can show a neutral retry message.
 */
export async function POST(req: Request) {
  let email = ''
  try {
    const body = await req.json().catch(() => ({}))
    email = typeof body?.email === 'string' ? body.email : ''
  } catch {
    email = ''
  }

  const outcome = await requestPasswordRecovery(email, 'member')
  // Only a genuine server fault is surfaced (neutral retry). Every other outcome —
  // account found or not, provider rate-limited or not — returns the SAME generic
  // response, so the endpoint can never be used to enumerate accounts.
  if (!outcome.ok && outcome.errorClass === 'server_error') {
    return NextResponse.json({ ok: false }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
