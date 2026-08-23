import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertSameOrigin } from '@/lib/http/sameOrigin'
import { getSiteUrl, getRecoveryRedirectUrl } from '@/lib/config/siteUrl'
import { revokeResumeToken } from '@/lib/invitations/resumeTokenStore'
import { mintResumeToken, buildResumeLink } from '@/lib/invitations/resumeToken'
import { sendSecureInviteEmail } from '@/lib/email'
import { canSendInvitation } from '@/lib/invitations/featureGate'
import { buildRecoverLink } from '@/lib/invitations/secureInvite'
import { randomUUID } from 'node:crypto'

/**
 * ADMIN ROTATION — the ONLY path that retires a member's existing resume links.
 *
 * Ordinary activity never rotates. A reminder ADDS a resume token; an access-resend ADDS one; a
 * resume request consumes nothing at all. Every previously emailed link keeps working until a
 * terminal event. Rotation exists for the case where an admin has reason to believe a link is
 * compromised or must be re-issued deliberately, and it is an explicit POST — never a GET, never a
 * cron, never a side effect of anything else.
 *
 * ─── PREPARE → SEND → FINALIZE ────────────────────────────────────────────────────────────────
 * Retiring the old tokens first would be wrong. Sending mail has THREE outcomes, and on failure or
 * on an uncertain outcome the member would be left holding only dead links with no way to be told.
 * So:
 *
 *   PREPARE   mint the replacement token. Everything stays live — the member now has one more
 *             working link, which is never worse than before.
 *   SEND      one provider call, under an idempotency key derived from the durable delivery claim.
 *   FINALIZE  only on a DEFINITE acceptance, atomically supersede every other live token.
 *
 *   • definite failure  → revoke the replacement (its plaintext reached nobody); old links live on.
 *   • uncertain outcome → change NOTHING. The replacement stays live because the mail may have
 *                         arrived, and the old ones stay live because it may not have. Both sets
 *                         work, which is the recoverable direction; the admin can retry after the
 *                         delivery webhook resolves it.
 *
 * The consequence is stated plainly rather than hidden: an uncertain send leaves MORE live tokens
 * than intended, not fewer. That is the deliberate trade — an extra working link is a smaller harm
 * than a member locked out by a rotation nobody can confirm happened.
 */

/**
 * Rotation has its OWN delivery purpose. It previously reused 'access_resend', which meant an
 * existing accepted access-resend claim blocked rotation forever under migration 049's
 * one-active-attempt-per-(waitlist_id, purpose) index — a lock that can never be released. These
 * rows also carry waitlist_id NULL (see migration 077); rotation's concurrency boundary is the
 * operation row, which CAN be released on completion.
 */
const ROTATION_PURPOSE = 'resume_rotation'

export async function POST(req: Request) {
  const crossOrigin = assertSameOrigin(req as any)
  if (crossOrigin) return crossOrigin

  // Verified admin, checked server-side against the profile — never from a client claim.
  const supa = createClient()
  const { data: { user } } = await supa.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let admin: ReturnType<typeof createAdminClient>
  try { admin = createAdminClient() } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
  const { data: me } = await admin.from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
  if (me?.is_admin !== true) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Correlation id only — never a member, delivery, token or operation identifier.
  const cid = randomUUID().slice(0, 8)

  const body = await req.json().catch(() => ({})) as { waitlistId?: string; confirmRotate?: boolean }
  const waitlistId = typeof body.waitlistId === 'string' ? body.waitlistId.trim() : ''
  if (!waitlistId) return NextResponse.json({ error: 'waitlistId is required' }, { status: 400 })

  // Rotation destroys working links, so it requires its own explicit confirmation. It must not be
  // reachable by a stray call that merely happens to carry an id.
  if (body.confirmRotate !== true) {
    return NextResponse.json(
      { ok: false, error: 'confirmation_required',
        message: 'Rotation retires every existing resume link for this invitation. Send confirmRotate: true.' },
      { status: 400 },
    )
  }

  const { data: wl, error: wlErr } = await admin
    .from('waitlist').select('id, email, full_name, status').eq('id', waitlistId).maybeSingle()
  if (wlErr) return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  if (!wl?.email || wl.status !== 'invited') {
    return NextResponse.json({ ok: false, error: 'not_eligible' }, { status: 409 })
  }
  const email = String(wl.email).trim().toLowerCase()

  // Exactly one identity, resolved authoritatively. A rotation for an ambiguous address could bind
  // the replacement to the wrong person.
  const { data: idRows, error: idErr } = await admin.rpc('lookup_auth_identity', { p_email: email })
  if (idErr) return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  const id = Array.isArray(idRows) ? idRows[0] : idRows
  if (!id || (id.identity_count ?? 0) !== 1 || !id.auth_user_id) {
    return NextResponse.json({ ok: false, error: 'not_eligible' }, { status: 409 })
  }
  const authUserId: string = id.auth_user_id

  if (!canSendInvitation(email)) {
    return NextResponse.json({ ok: false, error: 'gated', message: 'Invitation sending is paused.' }, { status: 409 })
  }

  // ── PREPARE, idempotently. begin_resume_rotation() mints the replacement token AND the operation
  //    row in one transaction, or converges on an existing ACTIVE operation and creates nothing.
  //    Two admins pressing at once therefore share one operation and one provider call.
  const { token, tokenSha256 } = mintResumeToken()
  const { data: opRows, error: opErr } = await admin.rpc('begin_resume_rotation', {
    p_waitlist_id: waitlistId,
    p_auth_user_id: authUserId,
    p_token_sha256: `\\x${tokenSha256.toString('hex')}`,
  })
  if (opErr) {
    console.error(JSON.stringify({ event: 'resume_rotation_begin_failed', cid }))
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
  const op = Array.isArray(opRows) ? opRows[0] : opRows
  if (!op?.out_operation_id) return NextResponse.json({ error: 'unavailable' }, { status: 503 })

  // ── RESUME PATH. An operation whose email was already accepted but whose finalization failed is
  //    completed WITHOUT sending anything. This is the case the previous version could not recover:
  //    a retry saw an in-flight delivery claim and had no idea which token to keep. The operation
  //    row remembers, so finalization simply continues.
  if (!op.out_created && op.out_state === 'accepted_pending_finalize') {
    const fin = await finalize(admin, op.out_operation_id, cid)
    return fin.ok
      ? NextResponse.json({ ok: true, rotated: true, state: 'rotated', retiredTokens: fin.retired })
      : NextResponse.json({ ok: false, rotated: false, state: 'sent_not_finalized',
          message: 'The new email was already sent. Retiring older links did not complete; retry to finish.' }, { status: 202 })
  }

  // An unresolved send must not be repeated until delivery evidence settles it.
  if (!op.out_created && op.out_state === 'uncertain') {
    return NextResponse.json({ ok: false, rotated: false, state: 'uncertain',
      message: 'A previous rotation has an unresolved delivery. Existing links still work. Retry once it resolves.' }, { status: 202 })
  }
  if (!op.out_created && op.out_state === 'prepared') {
    return NextResponse.json({ ok: false, rotated: false, state: 'in_flight',
      message: 'A rotation for this invitation is already in progress. Nothing was changed.' }, { status: 409 })
  }

  // Fresh authentication link. Generated here and passed ONLY to the email sender.
  let authLink: string
  try {
    const { data, error } = await admin.auth.admin.generateLink({
      type: 'recovery', email, options: { redirectTo: getRecoveryRedirectUrl() },
    } as any)
    const hashedToken = (data as any)?.properties?.hashed_token
    if (error || !hashedToken) throw new Error('generateLink failed')
    authLink = buildRecoverLink({ siteUrl: getSiteUrl(), hashedToken, type: 'recovery' })
  } catch {
    await revokeResumeToken(admin, op.out_replacement_token_id)
    await admin.rpc('record_resume_rotation_outcome', {
      p_operation_id: op.out_operation_id, p_state: 'failed', p_error_class: 'link_generation_failed',
    })
    return NextResponse.json({ ok: false, rotated: false, state: 'failed' }, { status: 503 })
  }

  // Durable delivery record for this send. waitlist_id NULL keeps it out of 049's one-per-purpose
  // lock; the operation row is the concurrency boundary.
  const { data: claim } = await admin.from('invitation_deliveries').insert({
    waitlist_id: null, auth_user_id: authUserId, recipient_email: email,
    purpose: ROTATION_PURPOSE, status: 'claimed', attempt_number: 1,
  }).select('id').maybeSingle()

  // ── SEND. The key is the operation's STABLE event key, so a resumed attempt reuses one key with
  //    one payload — never a new key with a regenerated link.
  const send = await sendSecureInviteEmail({
    to: email, toName: wl.full_name || 'there',
    link: authLink, resumeLink: buildResumeLink(getSiteUrl(), token),
    referrerName: null, idempotencyKey: op.out_event_key,
  })

  if (send.uncertain) {
    // Change NOTHING. The mail may have arrived, so the replacement stays live; it may not have, so
    // the old links stay live too. More working links than intended, never fewer.
    await admin.rpc('record_resume_rotation_outcome', {
      p_operation_id: op.out_operation_id, p_state: 'uncertain',
      p_delivery_id: claim?.id ?? null, p_error_class: 'provider_timeout',
    })
    console.log(JSON.stringify({ event: 'resume_rotation_uncertain', cid }))
    return NextResponse.json({ ok: false, rotated: false, state: 'uncertain',
      message: 'Delivery status is pending. Nothing was retired — existing links still work. Retry once it resolves.' }, { status: 202 })
  }

  if (!send.success) {
    // Definite failure: the plaintext reached nobody. Retire only the replacement and leave every
    // prior link exactly as it was. The operation becomes 'failed', which frees the invitation for
    // a genuine retry.
    await revokeResumeToken(admin, op.out_replacement_token_id)
    if (claim?.id) {
      await admin.from('invitation_deliveries')
        .update({ status: 'failed', error_class: send.errorClass ?? 'provider_error' }).eq('id', claim.id)
    }
    await admin.rpc('record_resume_rotation_outcome', {
      p_operation_id: op.out_operation_id, p_state: 'failed',
      p_delivery_id: claim?.id ?? null, p_error_class: send.errorClass ?? 'provider_error',
    })
    console.log(JSON.stringify({ event: 'resume_rotation_failed', cid, class: send.errorClass ?? 'provider_error' }))
    return NextResponse.json({ ok: false, rotated: false, state: 'failed',
      message: 'The email could not be sent. Nothing was rotated and existing links still work.' }, { status: 502 })
  }

  // ── ACCEPTANCE IS RECORDED BEFORE FINALIZATION. If the process dies here, a retry finds
  //    'accepted_pending_finalize' and completes without sending a second email.
  if (claim?.id) {
    try {
      await admin.from('invitation_deliveries')
        .update({ status: 'accepted', provider_message_id: send.messageId ?? null }).eq('id', claim.id)
    } catch { /* provider already accepted */ }
  }
  const { error: accErr } = await admin.rpc('record_resume_rotation_outcome', {
    p_operation_id: op.out_operation_id, p_state: 'accepted_pending_finalize', p_delivery_id: claim?.id ?? null,
  })
  if (accErr) {
    console.error(JSON.stringify({ event: 'resume_rotation_accept_record_failed', cid }))
    return NextResponse.json({ ok: false, rotated: false, state: 'sent_not_finalized',
      message: 'The new email was sent, but the rotation was not recorded. Retry to finish.' }, { status: 202 })
  }

  // ── FINALIZE.
  const fin = await finalize(admin, op.out_operation_id, cid)
  return fin.ok
    ? NextResponse.json({ ok: true, rotated: true, state: 'rotated', retiredTokens: fin.retired })
    : NextResponse.json({ ok: false, rotated: false, state: 'sent_not_finalized',
        message: 'The new email was sent, but older links were not retired. Retry to finish.' }, { status: 202 })
}

/** Retire older live tokens for a rotation whose email was definitely accepted. Idempotent. */
async function finalize(admin: any, operationId: string, cid: string): Promise<{ ok: boolean; retired: number }> {
  const { data, error } = await admin.rpc('finalize_resume_rotation', { p_operation_id: operationId })
  if (error) {
    console.error(JSON.stringify({ event: 'resume_rotation_finalize_failed', cid }))
    return { ok: false, retired: 0 }
  }
  const row = Array.isArray(data) ? data[0] : data
  const retired = Number(row?.out_retired ?? 0)
  if (row?.out_state !== 'finalized') {
    console.error(JSON.stringify({ event: 'resume_rotation_not_finalized', cid, state: row?.out_state ?? 'unknown' }))
    return { ok: false, retired: 0 }
  }
  console.log(JSON.stringify({ event: 'resume_rotation_completed', cid, retired }))
  return { ok: true, retired }
}
