import { getRecoveryRedirectUrl, getSiteUrl } from '@/lib/config/siteUrl'
import { buildRecoverLink } from '@/lib/invitations/secureInvite'
import { sendSecureInviteEmail } from '@/lib/email'

/**
 * Send a fresh authentication link for an ALREADY-AUTHORIZED resume claim.
 *
 * ─── WHY THIS EXISTS INSTEAD OF REUSING sendSecureInvite() ────────────────────────────────────
 * sendSecureInvite() is the NEW-INVITATION orchestrator, and it classifies a target as `active` —
 * refusing to send — when `last_sign_in_at` is set OR any profiles row exists:
 *
 *     if (user) activated = !!user.last_sign_in_at || (await deps.hasProfile(user.id))
 *
 * That is right for its own job: an admin should not "invite" someone who already has an account.
 * It is catastrophically wrong here. The approved catch-up cohort is defined as people who signed
 * in and did NOT finish — every one of them is `activated` by that test. All 18 could receive a
 * reminder, press "Continue setting up", see the generic success message, and get nothing. A silent
 * no-op for exactly the population the feature exists to serve.
 *
 * The right fix is not a flag on the classifier. Authorization has ALREADY happened, atomically,
 * inside claim_invitation_resume_request(): invitation status, identity binding, incompletion,
 * suppression, uniqueness and rate limits were all decided under a row lock. This function's job is
 * to act on that decision, not to re-litigate it with a different rule set.
 *
 * ─── IT TAKES NOTHING FROM THE BROWSER ────────────────────────────────────────────────────────
 * The only inputs are the two SERVER-DERIVED values the claim returned. No email, no uuid, no
 * redirect and no link ever crosses in from a request body. The address is re-read from the
 * invitation, so a forged or forwarded token can still only cause mail to the rightful recipient.
 *
 * It nevertheless RE-VERIFIES everything before sending. The claim happened moments earlier, and
 * "moments" is enough for a profile to complete or an admin to revoke.
 */

export type ResumeSendState =
  | 'sent'          // provider accepted
  | 'uncertain'     // provider outcome unknown — never retried under a new key
  | 'failed'        // definite failure — safe to retry
  | 'ineligible'    // state changed between the claim and now
  | 'in_flight'     // another send for this identity is already claimed
  | 'unavailable'   // a lookup or write we could not complete — fail closed

export interface ResumeSendResult {
  state: ResumeSendState
  /** Coarse class for logging. Never a provider or database message. */
  errorClass?: string
}

const RESUME_PURPOSE = 'resume_access'
export async function sendResumeAccessEmail(
  admin: any,
  input: { waitlistId: string; authUserId: string },
): Promise<ResumeSendResult> {
  const { waitlistId, authUserId } = input
  if (!waitlistId || !authUserId) return { state: 'unavailable' }

  // ── Re-resolve the invitation from the id the claim returned. ──
  const { data: wl, error: wlErr } = await admin
    .from('waitlist').select('id, email, full_name, status').eq('id', waitlistId).maybeSingle()
  if (wlErr) return { state: 'unavailable' }
  if (!wl?.email || wl.status !== 'invited') return { state: 'ineligible' }   // EXACTLY invited
  const email = String(wl.email).trim().toLowerCase()

  // ── Identity must still be unique AND still be the bound one. ──
  const { data: idRows, error: idErr } = await admin.rpc('lookup_auth_identity', { p_email: email })
  if (idErr) return { state: 'unavailable' }
  const id = Array.isArray(idRows) ? idRows[0] : idRows
  if (!id) return { state: 'unavailable' }
  if ((id.identity_count ?? 0) !== 1 || !id.auth_user_id) return { state: 'ineligible' }
  if (id.auth_user_id !== authUserId) return { state: 'ineligible' }          // replaced/recreated

  // ── Still incomplete. A profile that finished between the claim and now ends the capability. ──
  const { data: prof, error: profErr } = await admin
    .from('profiles').select('profile_complete').eq('id', authUserId).maybeSingle()
  if (profErr) return { state: 'unavailable' }
  if (prof?.profile_complete === true) return { state: 'ineligible' }

  // ── Suppression: ANY historical bounce/block/complaint. ──
  const { data: supp, error: suppErr } = await admin
    .from('invitation_deliveries').select('id')
    .eq('recipient_email', email).in('status', ['bounced', 'blocked', 'complained']).limit(1)
  if (suppErr) return { state: 'unavailable' }
  if (supp?.length) return { state: 'ineligible' }

  // ── ATOMIC CLAIM. The check and the insert happen in ONE database transaction under an advisory
  //    lock keyed on the bound auth user (migration 078). The previous code SELECTed for a recent
  //    'claimed' row and then separately INSERTed one — two concurrent presses both read "nothing in
  //    flight" and both called the provider. Nothing in the schema serialized them either, because
  //    resume_access rows carry waitlist_id NULL specifically to escape migration 049's index.
  //
  //    The coarse states are decided in the database, not here, so no application branch can
  //    reintroduce a time-based unlock of an uncertain send.
  const { data: claimRows, error: claimErr } = await admin.rpc('claim_resume_access_attempt', {
    p_auth_user_id: authUserId, p_email: email,
  })
  if (claimErr) return { state: 'unavailable' }
  const claimRow = Array.isArray(claimRows) ? claimRows[0] : claimRows
  const claimState: string = claimRow?.out_state ?? 'invalid'

  // An UNCERTAIN previous attempt is terminal for automatic retry. It does not expire: "we do not
  // know" never becomes "it failed" because time passed, and a new idempotency key carrying a
  // regenerated link is exactly how one uncertain send becomes two delivered emails.
  if (claimState === 'uncertain_review') return { state: 'in_flight', errorClass: 'uncertain_review' }
  if (claimState === 'in_flight') return { state: 'in_flight' }
  if (claimState === 'debounced') return { state: 'in_flight', errorClass: 'debounced' }
  if (claimState !== 'created' || !claimRow?.out_delivery_id) return { state: 'unavailable' }
  const claim = { id: claimRow.out_delivery_id as string }

  // ── Fresh Supabase RECOVERY link. 'recovery' and never 'invite': the auth user already exists,
  //    and an invite-type link would be the wrong ceremony for someone who has signed in before.
  //
  //    A failure HERE is genuinely pre-dispatch — the row is still 'pending', nothing was sent, and
  //    the lease may safely retire it for a later retry.
  let authLink: string
  try {
    const { data, error } = await admin.auth.admin.generateLink({
      type: 'recovery', email, options: { redirectTo: getRecoveryRedirectUrl() },
    } as any)
    const hashedToken = (data as any)?.properties?.hashed_token
    if (error || !hashedToken) throw new Error('generateLink failed')
    authLink = buildRecoverLink({ siteUrl: getSiteUrl(), hashedToken, type: 'recovery' })
  } catch {
    await admin.from('invitation_deliveries')
      .update({ status: 'failed', dispatch_state: 'pending', error_class: 'link_generation_failed' })
      .eq('id', claim.id)
    return { state: 'failed', errorClass: 'link_generation_failed' }
  }

  // ══ THE PRE-PROVIDER MARKER ══════════════════════════════════════════════════════════════════
  // The row is moved to 'dispatching' BEFORE the provider is contacted, and the provider is contacted
  // ONLY if exactly one still-pre-dispatch row transitioned.
  //
  // WHY THIS ORDER IS THE WHOLE FIX. Previously the row stayed 'pending' across the entire provider
  // call. A process that died mid-call — or after the provider accepted but before the post-call
  // update landed — left a row indistinguishable from one where nothing had been attempted, so the
  // lease retired it as stale_pre_dispatch and a second email went out under a new idempotency key.
  // One crash, two emails. From this line onward the row already says a dispatch may have happened,
  // so no crash can be misread as "never attempted".
  const { data: marked, error: markErr } = await admin.rpc('begin_resume_dispatch', {
    p_delivery_id: claim.id,
  })
  // Supabase query builders return { error }; they do not necessarily throw. An unchecked call here
  // would proceed to the provider on a failure it never noticed.
  if (markErr || marked !== true) return { state: 'in_flight', errorClass: 'dispatch_marker_failed' }

  const send = await sendSecureInviteEmail({
    to: email, toName: wl.full_name || 'there',
    link: authLink, resumeLink: null, referrerName: null,
    idempotencyKey: `resume:${claim.id}`,   // one key ⇄ one payload; a retry takes a fresh claim
  })

  // ══ POST-PROVIDER BOOKKEEPING ════════════════════════════════════════════════════════════════
  // Every transition below is checked. If ANY of them fails, the row stays 'dispatching' — which is
  // permanently non-auto-retryable. That is the only honest resting state for "the provider may have
  // taken it and we could not record what happened", and the safe direction is always
  // "possibly sent; do not resend".
  if (send.success) {
    const { error: accErr } = await admin.from('invitation_deliveries')
      .update({ status: 'accepted', dispatch_state: 'dispatched', provider_message_id: send.messageId ?? null })
      .eq('id', claim.id)
    if (accErr) {
      // Left 'dispatching'. Not an error the caller should retry — the email went out.
      return { state: 'sent', errorClass: 'accept_record_failed' }
    }
    return { state: 'sent' }
  }

  if (send.uncertain) {
    // Narrow 'dispatching' to 'uncertain'. Both are non-retryable, so a failure to make this
    // transition changes nothing about safety — it only costs some diagnostic precision.
    const { error: uncErr } = await admin.from('invitation_deliveries')
      .update({ dispatch_state: 'uncertain', error_class: 'provider_timeout' })
      .eq('id', claim.id)
    return { state: 'uncertain', errorClass: uncErr ? 'uncertain_record_failed' : 'provider_timeout' }
  }

  // DEFINITE refusal: the provider explicitly declined it, so no message exists and this may become
  // retryable. This is the ONLY post-provider path that relaxes the state, and it is applied only on
  // an unambiguous refusal.
  const { error: failErr } = await admin.from('invitation_deliveries')
    .update({ status: 'failed', dispatch_state: 'dispatched', error_class: send.errorClass ?? 'provider_error' })
    .eq('id', claim.id)
  if (failErr) {
    // Could not record the refusal. The row stays 'dispatching' and therefore stays non-retryable —
    // deliberately erring towards "possibly sent" rather than resending on an unrecorded outcome.
    return { state: 'uncertain', errorClass: 'failure_record_failed' }
  }
  return { state: 'failed', errorClass: send.errorClass ?? 'provider_error' }
}
