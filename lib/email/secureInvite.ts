import { escapeHtml } from '@/lib/email/escapeHtml'

/**
 * Pure builder for the secure invitation email — subject, HTML and text.
 *
 * Extracted so the admin preview renders THE SAME CODE that sends. A preview assembled separately
 * drifts from the real template the first time either is edited, and then it certifies copy nobody
 * actually receives. Follows the existing builder pattern (buildNominationInviteEmail,
 * buildRecommendationIntroEmail, buildNewIntroductionsEmail, buildWednesdayReminderEmail).
 *
 * PURE: no network, no database, no token minting. `link` and `resumeLink` are supplied by the
 * caller, which is what lets the preview pass inert placeholders while the sender passes real ones.
 */
/**
 * How long the Supabase authentication link lives, in prose, for the recipient.
 *
 * ONE STRING, because the number itself is NOT ours to set: the link is verified by
 * supabase.auth.verifyOtp({token_hash}), so its lifetime is the project's Email OTP expiry
 * (MAILER_OTP_EXP) in the Supabase dashboard — not a value in this repo, and not an option
 * generateLink accepts. If that dashboard setting is raised, change this sentence to match; it is
 * the only place the email commits to a duration.
 *
 * SAYING IT AT ALL IS THE POINT. The previous copy said only "expires for your protection", which
 * tells a reader nothing actionable — someone who reads email in batches has no way to know the
 * window is this short until they have already missed it.
 */
export const AUTH_LINK_LIFETIME_PROSE = 'about an hour'

export interface SecureInviteEmailInput {
  toName: string
  /** Consent-gated by the caller (migration 037). Null → anonymous copy. */
  referrerName?: string | null
  /** Supabase authentication link. Expires by design. */
  link: string
  /** Durable resume link (migration 078). Absent → the older "request a new link" wording. */
  resumeLink?: string | null
  purpose?: 'first_invite' | 'access_resend' | 'account_recovery'
}

export interface BuiltSecureInviteEmail {
  subject: string
  html: string
  text: string
  /** Exposed for the preview so an operator can see which variant they are looking at. */
  variant: 'first_invite' | 'access_resend'
}

export function buildSecureInviteEmail(input: SecureInviteEmailInput): BuiltSecureInviteEmail {
  const firstName = ((input.toName || '').trim().split(/\s+/)[0]) || 'there'
  const resume = (input.resumeLink || '').trim()
  const recommendedBy = (input.referrerName || '').trim()

  // CATCH-UP COPY. A person whose first invitation expired before they used it must not be sent
  // something that reads as a first contact — to them it looks either like a duplicate they already
  // ignored, or like the original never arrived. It names the gap and takes responsibility for the
  // silence, which is also the honest answer to "why am I hearing from you now".
  //
  // NO DATE. The affected cohort was invited across several months, and a hardcoded month would be
  // wrong for most of them. invited_at is deliberately not interpolated either: "we sent you an
  // invitation" is true regardless of when, and a six-week-old date in the body invites the reader
  // to wonder why it took six weeks rather than to click the link.
  const isResend = input.purpose === 'access_resend'
  const headline = isResend ? 'Your Andrel invitation' : "You're invited to Andrel"
  const subject = isResend
    ? 'Your Andrel invitation — a working link'
    : 'Welcome to Andrel — set up your account'
  const introLine = isResend
    ? (recommendedBy
        ? `${escapeHtml(recommendedBy)} recommended you for Andrel, and we sent you an invitation that expired before you had a chance to use it. We didn't follow up — that's on us.`
        : `You were recommended for Andrel, and we sent you an invitation that expired before you had a chance to use it. We didn't follow up — that's on us.`)
    : (recommendedBy
        ? `${escapeHtml(recommendedBy)} recommended you for Andrel. Use the secure link below to set your password and finish setting up your account.`
        : `You've been invited to join Andrel. Use the secure link below to set your password and finish setting up your account.`)
  // Only the resend variant gets the second line; a first invite reads fine without it.
  const secondLine = isResend
    ? `<p style="font-size:16px; line-height:1.6;">Here's a fresh link, and this time a backup if it lapses again.</p>`
    : ''

  const html = `
        <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; color:#334155;">
          <h2 style="color:#1B2850; margin-bottom:16px;">${headline}</h2>
          <p style="font-size:16px; line-height:1.6;">Hi ${escapeHtml(firstName)},</p>
          <p style="font-size:16px; line-height:1.6;">${introLine}</p>
          ${secondLine}
          <p style="margin:28px 0 20px;">
            <a href="${input.link}" style="display:inline-block; background:#1B2850; color:#ffffff; text-decoration:none; font-size:16px; font-weight:600; padding:14px 32px; border-radius:10px;">Set up my account</a>
          </p>
          ${resume ? `<p style="font-size:15px; line-height:1.6; color:#334155; background:#f8fafc; border-left:3px solid #1B2850; padding:12px 16px; margin:0 0 20px;">
            That button expires ${AUTH_LINK_LIFETIME_PROSE} after this email was sent. If it has,
            <a href="${resume}" style="color:#1B2850; font-weight:600;">send me a working link</a> —
            that one doesn't expire, and it emails a fresh sign-in link straight back to this address.
          </p>` : `<p style="font-size:15px; line-height:1.6; color:#334155; background:#f8fafc; border-left:3px solid #1B2850; padding:12px 16px; margin:0 0 20px;">
            That button expires ${AUTH_LINK_LIFETIME_PROSE} after this email was sent. If it has,
            request a new link from the Andrel sign-in page.
          </p>`}
          <p style="font-size:13px; color:#64748b; line-height:1.6;">
            This link is personal to you — please don't forward it.
          </p>
          <p style="font-size:13px; color:#64748b; line-height:1.6;">
            Don't see it? Check your spam/junk folder. Need help? Reply to this email or contact
            <a href="mailto:hello@andrel.app" style="color:#1B2850;">hello@andrel.app</a>.
          </p>
          <p style="font-size:13px; color:#94a3b8; margin-top:28px;">— The Andrel Team</p>
        </div>`

  // The text part branches identically — a recipient reading text/plain must not see first-invite
  // wording on a resend just because their client prefers plain text.
  const text =
    `${headline}.\n\nHi ${firstName},\n\n` +
    (isResend
      ? `${recommendedBy ? `${recommendedBy} recommended you for Andrel, and we` : `You were recommended for Andrel, and we`} sent you an invitation that expired before you had a chance to use it. We didn't follow up — that's on us.\n\n` +
        `Here's a fresh link, and this time a backup if it lapses again:\n\n`
      : `${recommendedBy ? `${recommendedBy} recommended you for Andrel.` : `You've been invited to join Andrel.`} Use the secure link below to set your password and finish setting up your account:\n\n`) +
    `${input.link}\n\n` +
    (resume
      ? `That link expires ${AUTH_LINK_LIFETIME_PROSE} after this email was sent. If it has, use this one instead — ` +
        `it doesn't expire, and it emails a fresh sign-in link straight back to this address:\n${resume}\n\n`
      : `That link expires ${AUTH_LINK_LIFETIME_PROSE} after this email was sent. If it has, request a new link ` +
        `from the Andrel sign-in page.\n\n`) +
    `This link is personal to you — please don't forward it.\n\n` +
    `Don't see it? Check your spam/junk folder. Need help? Contact hello@andrel.app.\n\n— The Andrel Team`

  return { subject, html, text, variant: isResend ? 'access_resend' : 'first_invite' }
}
