import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendSecureInviteEmail } from '@/lib/email'
import { logRecommendationEvent } from '@/lib/analytics/recommendationEvents'
import { normalizeEmail, lookupAuthUsersByEmail } from '@/lib/invitations'
import { isBlockedTransition, invalidTransitionMessage } from '@/lib/referrals/statusTransitions'
import { sendSecureInvite, type SecureInviteDeps } from '@/lib/invitations/secureInvite'
import { claimInviteDelivery, markDeliveryAccepted, markDeliveryFailed } from '@/lib/invitations/delivery'
import { canSendInvitation, invitationsMode, INVITATIONS_PAUSED_MESSAGE, INVITATION_TEST_BLOCKED_MESSAGE } from '@/lib/invitations/featureGate'
import { requestPasswordRecoveryForUserId } from '@/lib/auth/recoveryRequest'
import { getSiteUrl, getRecoveryRedirectUrl } from '@/lib/config/siteUrl'
import { mintBoundResumeLink, revokeResumeToken } from '@/lib/invitations/resumeTokenStore'
import { assertSameOrigin } from '@/lib/http/sameOrigin'
import {
  normalizeDesignation, canDesignateAtStatus, designationRequested,
  isCommunityConflict, communityConflictMessage, DESIGNATION_LOCKED_MESSAGE,
} from '@/lib/invitations/communityDesignation'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

/**
 * Admin Send-invitation / Resend-access. SECURE + PASSWORDLESS: a first invite (no auth user)
 * mints the user via generateLink({type:'invite'}) — no password; a not-activated existing
 * user gets generateLink({type:'recovery'}) — no duplicate. Either way the `hashed_token` is
 * embedded in a scanner-resistant /auth/recover#… link inside a custom Resend email; the
 * token is never returned, logged, or persisted. Provider acceptance is recorded in
 * invitation_deliveries and only THEN stamps invited_at for a genuine first invite. An active
 * member is a no-op (use the explicit password-reset action). action='password_reset' sends a
 * secure recovery link via the shared recovery flow — never a temp password.
 */
export async function POST(req: Request) {
  // CSRF: this is a cookie-authed state change that can send mail and mint an auth user, and now
  // also designates the community an invitation is FOR. Same standard-headers helper the other
  // admin mutations use (waitlist/change-email, invitations/rotate-resume, campaigns).
  const crossOrigin = assertSameOrigin(req)
  if (crossOrigin) return crossOrigin

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const entryId = body.entryId
  const markAsFounding = body.markAsFounding === true
  const force = body.force === true // explicit admin "new attempt" after the safe retry window
  const action: 'invite' | 'password_reset' = body.action === 'password_reset' ? 'password_reset' : 'invite'

  const { data: entry, error: entryErr } = await supabase.from('waitlist').select('*').eq('id', entryId).single()
  if (entryErr || !entry) return NextResponse.json({ error: 'Entry not found' }, { status: 404 })

  if (isBlockedTransition(entry.status, 'invited')) {
    return NextResponse.json({ error: invalidTransitionMessage(entry.status, 'invited') }, { status: 409 })
  }
  const email = normalizeEmail(entry.email)
  if (!email) return NextResponse.json({ error: 'Entry has no email' }, { status: 400 })

  const admin = createAdminClient()

  // Explicit admin password reset → secure recovery link (NEVER a temp password).
  if (action === 'password_reset') {
    let found
    try { found = await lookupAuthUsersByEmail(admin, email) }
    catch { return NextResponse.json({ error: 'Could not look up the member account.' }, { status: 500 }) }
    if (!found.user) return NextResponse.json({ success: false, state: 'no_account', message: 'No account exists for this email.' }, { status: 409 })
    const out = await requestPasswordRecoveryForUserId(found.user.id, 'admin')
    return NextResponse.json(out.sent
      ? { success: true, state: 'password_reset_sent' }
      : { success: false, state: 'error', message: 'Could not send the reset email. Please try again.' })
  }

  // ROLLOUT-MODE GATE (default off) — runs BEFORE any Auth lookup/mutation, token generation,
  // delivery claim, or provider call. Never falls back to the old password flow.
  //   off  → 503 paused;  test → only allowlisted recipients (else neutral 403);  on → proceed.
  if (!canSendInvitation(email)) {
    if (invitationsMode() === 'off') {
      return NextResponse.json({ success: false, state: 'paused', message: INVITATIONS_PAUSED_MESSAGE }, { status: 503 })
    }
    // test mode, recipient not on the allowlist — neutral, address-free message.
    return NextResponse.json({ success: false, state: 'not_allowlisted', message: INVITATION_TEST_BLOCKED_MESSAGE }, { status: 403 })
  }

  // ── ANDREL NEXT: THE COMMUNITY THIS INVITATION IS FOR ────────────────────────────────────────
  //
  // ORDERING IS THE SECURITY PROPERTY. This runs BEFORE sendSecureInvite, and therefore before
  // generateLink mints an auth user, before a resume token is minted, and before any provider call.
  // A refused or conflicting designation must leave NOTHING behind — the alternative, writing it in
  // the post-send status update, would mean an invitation had already gone out under a community
  // the database then refused to record.
  //
  // ABSENT MEANS PROFESSIONAL, AND MEANS NO WRITE AT ALL. The ordinary Professional send and every
  // resend reach here with no `intendedMemberType` field, so this block is a no-op for them and
  // that path stays byte-for-byte what it was. Migration 099 already defaulted every existing row
  // to 'professional'; nothing needs reclassifying.
  //
  // THE BROWSER PROPOSES, THE SERVER DECIDES. The value arrives from the admin console but is
  // whitelisted to exactly 'professional' | 'next' before it can reach the database, is accepted
  // only from an invitation that has not been issued yet, and is written with the SERVICE-ROLE
  // client after the admin identity check above. RLS independently restricts UPDATE on
  // public.waitlist to is_admin(), so this is authorized twice over — but neither of those is a
  // reason to pass an arbitrary value through.
  if (designationRequested(body)) {
    const intended = normalizeDesignation(body.intendedMemberType)

    // LIFECYCLE. Only an invitation still in approved/contacted may be designated. Once it has been
    // issued the community is fixed: migration 100 binds the first profile to it, and 099 makes the
    // resulting member_type immutable. There is deliberately no reclassification path here.
    if (!canDesignateAtStatus(entry.status)) {
      return NextResponse.json(
        { success: false, state: 'designation_locked', message: DESIGNATION_LOCKED_MESSAGE },
        { status: 409 })
    }

    // Skip a no-op write so the Professional path issues exactly the statements it always did.
    if (intended !== entry.intended_member_type) {
      const { error: desErr } = await admin
        .from('waitlist')
        .update({ intended_member_type: intended })
        .eq('id', entryId)

      if (desErr) {
        // Migration 099's conflicting-intent trigger: another LIVE row for this normalised address
        // already intends a different community. Translated by MESSAGE, never by SQLSTATE — 099
        // raises check_violation and so does every other CHECK in the schema, and an unrelated
        // constraint failure must keep its own message.
        if (isCommunityConflict(desErr)) {
          return NextResponse.json(
            { success: false, state: 'community_conflict', message: communityConflictMessage(intended) },
            { status: 409 })
        }
        return NextResponse.json(
          { success: false, state: 'error', message: 'Could not set the community for this invitation. Nothing was sent.' },
          { status: 500 })
      }
    }
  }

  const deps: SecureInviteDeps = {
    siteUrl: getSiteUrl(),
    lookupAuth: (e) => lookupAuthUsersByEmail(admin, e),
    hasProfile: async (uid) => {
      const { data } = await admin.from('profiles').select('id').eq('id', uid).maybeSingle()
      return !!data
    },
    claimDelivery: (purpose, authUserId) => claimInviteDelivery(admin, { waitlistId: entryId, authUserId, email, purpose }),
    markAccepted: (id, msgId, authUserId) => markDeliveryAccepted(admin, id, msgId, authUserId),
    markFailed: (id, errorClass) => markDeliveryFailed(admin, id, errorClass),
    generateLink: async (type, e) => {
      // Founding-member metadata is set ONLY on the first invite (type 'invite' creates the
      // user), via the SDK-supported generateLink `data` option — same user_metadata the old
      // createUser path set, consumed identically at onboarding. A recovery link never sets
      // data, so an inactive-user resend can't erase existing metadata. If this call fails, the
      // orchestrator marks the attempt failed and sends NO email.
      const options: any = { redirectTo: getRecoveryRedirectUrl() }
      if (markAsFounding && type === 'invite') options.data = { markAsFounding: true }
      const { data, error } = await admin.auth.admin.generateLink({ type, email: e, options } as any)
      const hashedToken = (data as any)?.properties?.hashed_token
      if (error || !hashedToken) throw new Error(error?.message || 'generateLink failed')
      return { hashedToken, userId: (data as any)?.user?.id ?? null }
    },
    // DURABLE FALLBACK for the FIRST invitation. Without this the initial email died with its
    // authentication link, and only people who later received a reminder ever got a resume link —
    // which is no use to someone who opened the first email a week late.
    mintResumeLink: (authUserId) =>
      mintBoundResumeLink(admin, { waitlistId: entryId, authUserId, siteUrl: getSiteUrl() }),
    // Revoked ONLY on a definite provider failure, where the plaintext reached nobody. An uncertain
    // outcome keeps it: the email may have arrived, and killing that link would be the worse error.
    revokeResumeToken: async (tokenId) => { await revokeResumeToken(admin, tokenId) },
    sendEmail: async (a) => {
      // CONSENT GATE: name the referrer ONLY when they explicitly consented (migration 037
      // unapplied → query errors → treated as no consent → anonymous copy).
      let referrerName: string | null = null
      if (entry.referral_source === 'referral') {
        const { data: referralRow } = await admin
          .from('referrals')
          .select('referrer_consent_to_share, referrer:profiles!referrer_user_id(full_name)')
          .eq('waitlist_id', entryId)
          .maybeSingle()
        if ((referralRow as any)?.referrer_consent_to_share === true) {
          referrerName = (referralRow?.referrer as any)?.full_name ?? null
        }
      }
      // a.purpose is secureInvite's own computation: 'access_resend' whenever this person already
      // has an auth account from an earlier invitation. Passing it through means the per-row
      // Resend in the admin panel gets the catch-up copy automatically.
      return sendSecureInviteEmail({ to: a.to, toName: a.toName, link: a.link, resumeLink: a.resumeLink ?? null, referrerName, purpose: a.purpose, idempotencyKey: a.idempotencyKey })
    },
  }

  const result = await sendSecureInvite(deps, { email, fullName: entry.full_name ?? null, waitlistId: entryId, force })

  if (result.state === 'active') {
    return NextResponse.json({ success: false, state: 'active', message: result.message }, { status: 200 })
  }
  if (result.state === 'ambiguous') {
    return NextResponse.json({ success: false, state: 'ambiguous', message: result.message }, { status: 409 })
  }
  if (result.state === 'unavailable') {
    // FAIL CLOSED: the pre-send delivery claim could not be persisted (e.g. migration 049 not
    // applied). Nothing was generated, mutated, or sent. Neutral 503.
    return NextResponse.json({ success: false, state: 'unavailable', message: result.message }, { status: 503 })
  }
  if (result.state === 'pending') {
    // An unresolved/in-flight claim exists — do NOT resend within the 24h idempotency window.
    return NextResponse.json({ success: false, state: 'pending', message: result.message }, { status: 200 })
  }
  if (result.state === 'uncertain') {
    // This send's outcome is unknown; the claim stays pending. Do not resend — await the webhook.
    return NextResponse.json({ success: false, state: 'uncertain', message: result.message }, { status: 202 })
  }
  if (result.state === 'needs_review') {
    // Past the 24h window — the admin must confirm a new attempt (force=true).
    return NextResponse.json({ success: false, state: 'needs_review', message: result.message }, { status: 409 })
  }
  if (!result.ok) {
    // Failure is retryable — nothing that implies a sent invite is written.
    return NextResponse.json({ success: false, state: 'error', message: result.message ?? 'Could not send the invitation.' }, { status: 500 })
  }

  // Provider ACCEPTED. Stamp invited_at only for a genuine first invite (mirrors prior semantics,
  // now gated on acceptance). An access-resend keeps status invited without re-implying delivery.
  if (result.state === 'invited') {
    // reminder_enrollment_at is the PROSPECTIVE ENROLLMENT BOUNDARY (migration 077). Stamping it
    // here — and only here, on a genuine first invite whose provider send was accepted — is what
    // separates the 117 historical invitees from everyone invited afterwards. There is no backfill:
    // a pre-077 row stays NULL forever and is therefore never picked up by the automatic worker.
    // It is set in the SAME update as invited_at so the two can never disagree.
    const stampedAt = new Date().toISOString()
    const { error: wlErr } = await supabase.from('waitlist').update({ status: 'invited', invited_at: stampedAt, reminder_enrollment_at: stampedAt }).eq('id', entryId)
    if (wlErr) return NextResponse.json({ error: 'Invite sent but status update failed. Please refresh.' }, { status: 500 })
    await admin.from('referrals').update({ status: 'invited' }).eq('waitlist_id', entryId)
    if (entry.referral_source === 'referral') logRecommendationEvent('recommendation_invite_sent', { entryId })
  } else {
    await supabase.from('waitlist').update({ status: 'invited' }).eq('id', entryId)
  }

  return NextResponse.json({ success: true, state: result.state })
}
