import { lookupAuthUsersByEmail } from '@/lib/invitations'
import { claimInviteDelivery, markDeliveryAccepted, markDeliveryFailed } from '@/lib/invitations/delivery'
import { sendSecureInvite, type SecureInviteDeps, type SecureInviteResult } from '@/lib/invitations/secureInvite'
import { sendSecureInviteEmail } from '@/lib/email'
import { getRecoveryRedirectUrl } from '@/lib/config/siteUrl'
import { mintBoundResumeLink, revokeResumeToken } from '@/lib/invitations/resumeTokenStore'

/**
 * Send a fresh secure sign-in email for an existing waitlist invitation, reusing the EXISTING
 * hardened ceremony end to end.
 *
 * This exists so the resume endpoint and the admin catch-up campaign do not each re-implement the
 * dependency wiring that /api/admin/send-invite already got right — pre-send atomic claim, single
 * provider send under a stable idempotency key, hashed_token only, token passed to nothing but the
 * email sender. A second hand-rolled copy of that orchestration is exactly how one of them would
 * eventually drift into sending twice, or into logging a link.
 *
 * DELIBERATELY OMITTED versus the admin route: founding-member metadata (only ever set on a first
 * invite, and this is never a first invite) and the referrer-consent copy (a resume email is a
 * transactional nudge to a person who already has an invitation, not an introduction to Andrel).
 *
 * The generated link is passed ONLY to sendEmail. It is never returned, logged or stored.
 */
export async function sendSecureInviteForWaitlist(
  admin: any,
  args: { waitlistId: string; email: string; fullName: string | null; siteUrl: string },
): Promise<SecureInviteResult> {
  const deps: SecureInviteDeps = {
    siteUrl: args.siteUrl,
    lookupAuth: (e) => lookupAuthUsersByEmail(admin, e),
    hasProfile: async (uid) => {
      const { data } = await admin.from('profiles').select('id').eq('id', uid).maybeSingle()
      return !!data
    },
    claimDelivery: (purpose, authUserId) =>
      claimInviteDelivery(admin, { waitlistId: args.waitlistId, authUserId, email: args.email, purpose }),
    markAccepted: (id, msgId, authUserId) => markDeliveryAccepted(admin, id, msgId, authUserId),
    markFailed: (id, errorClass) => markDeliveryFailed(admin, id, errorClass),
    generateLink: async (type, e) => {
      const { data, error } = await admin.auth.admin.generateLink({
        type, email: e, options: { redirectTo: getRecoveryRedirectUrl() },
      } as any)
      const hashedToken = (data as any)?.properties?.hashed_token
      if (error || !hashedToken) throw new Error('generateLink failed')
      return { hashedToken, userId: (data as any)?.user?.id ?? null }
    },
    // ADD a durable fallback; never rotate. An access-resend gives the member one MORE working
    // resume link — it does not retire the ones already in their inbox. Only an explicit admin
    // rotation does that.
    mintResumeLink: (authUserId) =>
      mintBoundResumeLink(admin, { waitlistId: args.waitlistId, authUserId, siteUrl: args.siteUrl }),
    revokeResumeToken: async (tokenId) => { await revokeResumeToken(admin, tokenId) },
    sendEmail: (a) => sendSecureInviteEmail({
      to: a.to, toName: a.toName, link: a.link, resumeLink: a.resumeLink ?? null,
      referrerName: null, idempotencyKey: a.idempotencyKey,
    }),
  }

  return sendSecureInvite(deps, {
    email: args.email,
    fullName: args.fullName,
    waitlistId: args.waitlistId,
  })
}
