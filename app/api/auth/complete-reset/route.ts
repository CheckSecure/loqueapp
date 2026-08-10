import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { finalizeResetForUser, destForOutcome } from '@/lib/auth/finalizeReset'
import { issueContinuationToken, verifyContinuationToken, CONTINUATION_COOKIE, CONTINUATION_TTL_MS } from '@/lib/auth/resetContinuation'

export const dynamic = 'force-dynamic'

/**
 * Secure password-reset completion. TRUST BOUNDARY: `password_reset_required` is cleared here ONLY
 * as a first-hand consequence of a server-performed password update —
 *   mode 'set'      → update the password (server-side, using the authenticated recovery session;
 *                     the password is never logged/stored), then clear the flag in the SAME request;
 *   mode 'finalize' → a password-free retry, authorized ONLY by the HttpOnly, signed, user-bound
 *                     continuation cookie this route issues after a confirmed update.
 * No client value (sessionStorage marker, phase, body flag) can clear the flag without one of these.
 * Recovery-token verification is unchanged — it already happened at /auth/recover (verifyOtp); this
 * route merely uses the resulting session.
 */
export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user }, error: userErr } = await supabase.auth.getUser()
  if (userErr || !user) {
    return NextResponse.json({ ok: false, stage: 'auth', message: 'Your session has expired. Please use the link again.' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({} as any))
  const mode: 'set' | 'finalize' = body?.mode === 'finalize' ? 'finalize' : 'set'
  const admin = createAdminClient()
  const jar = cookies()
  const cookieBase = { httpOnly: true as const, secure: true as const, sameSite: 'lax' as const, path: '/api/auth' }
  const dropCookie = () => { try { jar.set(CONTINUATION_COOKIE, '', { ...cookieBase, maxAge: 0 }) } catch { /* ignore */ } }

  // ── Password-free finalize retry: authorized ONLY by the server-issued continuation cookie. ──
  if (mode === 'finalize') {
    const token = jar.get(CONTINUATION_COOKIE)?.value
    if (!verifyContinuationToken(token, user.id, Date.now())) {
      // No trustworthy evidence of a completed update (e.g. a forged client marker) → refuse.
      return NextResponse.json({ ok: false, stage: 'finalize', message: 'This step expired. Please sign in with your new password.' }, { status: 401 })
    }
    const outcome = await finalizeResetForUser(admin, user.id)
    if (outcome === 'error') return NextResponse.json({ ok: false, stage: 'finalize' }, { status: 200 })
    dropCookie()
    return NextResponse.json({ ok: true, dest: destForOutcome(outcome) })
  }

  // ── Initial set: perform the password update SERVER-SIDE (password never logged/stored). ──
  const password = typeof body?.password === 'string' ? body.password : ''
  if (password.length < 8) {
    return NextResponse.json({ ok: false, stage: 'update', message: 'Password must be at least 8 characters.' }, { status: 400 })
  }

  // Uses the recovery session; GoTrue still enforces "new password must differ from the old", so a
  // legacy temp-password user cannot re-set the same password to clear the flag.
  const { error: updErr } = await supabase.auth.updateUser({ password })
  if (updErr) {
    const msg = /expired|invalid/i.test(updErr.message)
      ? 'This link has expired. Please request a new one.'
      : (/should be different|same/i.test(updErr.message) ? 'Please choose a password different from your current one.' : 'Could not update your password. Please try again.')
    return NextResponse.json({ ok: false, stage: 'update', message: msg }, { status: 422 })
  }

  // Password CONFIRMED changed in this execution. Issue the continuation cookie (evidence for a
  // password-free retry) BEFORE the clear, then clear the flag.
  const token = issueContinuationToken(user.id, Date.now())
  if (token) { try { jar.set(CONTINUATION_COOKIE, token, { ...cookieBase, maxAge: Math.floor(CONTINUATION_TTL_MS / 1000) }) } catch { /* ignore */ } }

  const outcome = await finalizeResetForUser(admin, user.id)
  if (outcome === 'error') return NextResponse.json({ ok: false, stage: 'finalize' }, { status: 200 })
  dropCookie()
  return NextResponse.json({ ok: true, dest: destForOutcome(outcome) })
}
