import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertSameOrigin } from '@/lib/http/sameOrigin'
import { parseResumeToken, sha256, RESUME_GENERIC_RESPONSE, type ResumeClaimStatus } from '@/lib/invitations/resumeToken'
import { canSendInvitation } from '@/lib/invitations/featureGate'

/**
 * POST ONLY, DELIBERATELY.
 *
 * There is no GET handler on this route and there must never be one. A GET would be followed by
 * link scanners, corporate mail security and chat previewers, which would burn rate limit and send
 * unrequested email on the recipient's behalf. Every state change requires a deliberate human
 * button press — the same rule /auth/recover already follows.
 *
 * WHAT THIS ENDPOINT WILL NOT DO:
 *   • it never returns a Supabase authentication or recovery URL to the browser;
 *   • it never creates a session;
 *   • it never reveals whether the token, invitation or account exists.
 * One fixed response body is returned for success and for every possible failure.
 */
export async function POST(req: Request) {
  const crossOrigin = assertSameOrigin(req as any)
  if (crossOrigin) return crossOrigin

  const generic = () => NextResponse.json({ ok: true, message: RESUME_GENERIC_RESPONSE })
  const unavailable = () => NextResponse.json(
    { ok: false, message: 'This is temporarily unavailable. Please try again shortly.' }, { status: 503 })

  // Correlation id ONLY. It is generated per request, stored nowhere, and cannot identify a member
  // — the previous version logged the raw waitlist_id, which is a durable member identifier and had
  // no business being in a log line for an unauthenticated endpoint.
  const cid = Math.random().toString(36).slice(2, 10)

  let body: unknown = {}
  try { body = await req.json() } catch { /* empty body → generic */ }

  const token = parseResumeToken((body as { token?: unknown })?.token)
  // Malformed input is indistinguishable from a valid-but-unknown token, on purpose.
  if (!token) return generic()

  let admin: ReturnType<typeof createAdminClient>
  try { admin = createAdminClient() } catch {
    console.error(JSON.stringify({ event: 'resume_admin_client_unavailable', cid }))
    return unavailable()
  }

  // ONE atomic call performs every eligibility check AND the rate-limit increment under a row lock.
  // Re-checking HERE rather than at page render is what closes the TOCTOU window: a profile
  // completed, or an invitation revoked, between the page load and this press is seen now.
  const { data, error } = await admin.rpc('claim_invitation_resume_request', {
    p_token_sha256: `\\x${sha256(token).toString('hex')}`,
  })

  if (error) {
    // Code only. A database message can echo the input that produced it.
    console.error(JSON.stringify({ event: 'resume_claim_failed', cid, code: (error as { code?: string }).code ?? 'unknown' }))
    return unavailable()
  }

  const row = Array.isArray(data) ? data[0] : data
  const status = (row?.status ?? 'invalid') as ResumeClaimStatus

  // Every non-'ok' status returns the SAME body as success. The distinction exists in the database
  // for operators, and nowhere else.
  if (status !== 'ok' || !row?.out_waitlist_id) return generic()

  // The recipient is NEVER taken from the request. Both values below came from the atomic claim,
  // and the sender re-resolves the address from the invitation itself — which is what makes a
  // forwarded token harmless: it can only cause mail to the rightful address.
  if (!row.out_auth_user_id) return generic()

  // The rollout gate still applies; a resume request is an invitation email like any other. The
  // address is read server-side purely for this check and is not passed to the sender.
  const { data: gateRow, error: gateErr } = await admin
    .from('waitlist').select('email').eq('id', row.out_waitlist_id).maybeSingle()
  if (gateErr || !gateRow?.email) return generic()
  if (!canSendInvitation(gateRow.email)) {
    console.log(JSON.stringify({ event: 'resume_send_gated', cid }))
    return generic()
  }

  // The DEDICATED resume sender — NOT sendSecureInvite(), whose new-invitation classifier treats
  // anyone with last_sign_in_at or a profile row as 'active' and refuses to send. That is precisely
  // the cohort this endpoint serves, so routing through it made the button a silent no-op for all
  // of them. Authorization already happened atomically in the claim above.
  try {
    const { sendResumeAccessEmail } = await import('@/lib/invitations/sendResumeAccess')
    const result = await sendResumeAccessEmail(admin, {
      waitlistId: row.out_waitlist_id, authUserId: row.out_auth_user_id,
    })
    // Internal outcome for operators. The BROWSER response below is identical either way.
    console.log(JSON.stringify({ event: 'resume_send', cid, state: result.state, class: result.errorClass ?? null }))
  } catch {
    console.error(JSON.stringify({ event: 'resume_send_exception', cid }))
  }

  // Identical to every failure above. Success and refusal are indistinguishable to the caller.
  return generic()
}
