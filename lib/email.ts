import { Resend } from 'resend'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildRecommendationIntroEmail } from '@/lib/email/recommendationIntro'
import { introReminderCopy } from '@/lib/notifications/engagement'
import { formatMeetingTimes } from '@/lib/meetings/formatMeetingTime'
import { buildNominationInviteEmail } from '@/lib/email/nominationInvite'

const resend = new Resend(process.env.RESEND_API_KEY)

type NotifCategory =
  | 'email_new_introductions'
  | 'email_messages'
  | 'email_meeting_updates'
  | 'email_opportunities'
  | 'email_product_updates'

type NotifCategoryWithDigest = NotifCategory | 'email_daily_digest'

async function isPrefEnabled(toEmail: string, category: NotifCategoryWithDigest): Promise<boolean> {
  try {
    const admin = createAdminClient()
    const { data: profile } = await admin
      .from('profiles')
      .select('id')
      .eq('email', toEmail)
      .maybeSingle()
    if (!profile) return true
    const { data: prefs } = await admin
      .from('notification_preferences')
      .select(category)
      .eq('user_id', profile.id)
      .maybeSingle()
    if (!prefs) return true
    const enabled = (prefs as Record<string, boolean>)[category] !== false
    if (!enabled) {
      console.log(JSON.stringify({
        event: 'email_suppressed',
        category,
        recipient_id: profile.id,
        reason: 'user_preference',
      }))
    }
    return enabled
  } catch {
    return true
  }
}

export function escapeHtml(s: string | null | undefined): string {
  if (!s) return '—'
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.lastIndexOf(' ', max)
  return (cut > 0 ? s.slice(0, cut) : s.slice(0, max)) + '…'
}

export async function sendMatchCreatedEmail(
  toEmail: string,
  toName: string,
  matchName: string,
  matchRole?: string,
  matchCompany?: string
) {
  if (!await isPrefEnabled(toEmail, 'email_new_introductions')) return
  const roleCompany = [matchRole, matchCompany].filter(Boolean).join(' at ')
  
  await resend.emails.send({
    from: 'Andrel <hello@andrel.app>',
    to: toEmail,
    subject: 'New Connection on Andrel',
    html: `
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1B2850; margin-bottom: 24px;">You have a new connection</h2>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
          Hi ${toName},
        </p>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
          We've facilitated an introduction between you and <strong>${matchName}</strong>${roleCompany ? ` (${roleCompany})` : ''}.
        </p>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
          You can now message each other and schedule a meeting.
        </p>
        <a href="https://andrel.app/dashboard/network" 
           style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
          View in Network
        </a>
        <p style="color: #64748b; font-size: 14px; margin-top: 32px;">
          — The Andrel Team
        </p>
      </div>
    `,
  })
}

export async function sendNewMessageEmail(
  toEmail: string,
  toName: string,
  fromName: string,
  messagePreview: string
) {
  if (!await isPrefEnabled(toEmail, 'email_messages')) return
  await resend.emails.send({
    from: 'Andrel <hello@andrel.app>',
    to: toEmail,
    subject: `New message from ${fromName}`,
    html: `
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1B2850; margin-bottom: 24px;">New message from ${fromName}</h2>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
          Hi ${toName},
        </p>
        <div style="background: #F5F6FB; border-left: 3px solid #1B2850; padding: 16px; margin: 24px 0; border-radius: 4px;">
          <p style="color: #334155; font-size: 15px; margin: 0;">
            ${messagePreview.length > 150 ? messagePreview.substring(0, 150) + '...' : messagePreview}
          </p>
        </div>
        <a href="https://andrel.app/dashboard/messages" 
           style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
          Reply to Message
        </a>
        <p style="color: #64748b; font-size: 14px; margin-top: 32px;">
          — The Andrel Team
        </p>
      </div>
    `,
  })
}

export async function sendNewBatchEmail(
  toEmail: string,
  toName: string,
  introCount: number
) {
  if (!await isPrefEnabled(toEmail, 'email_new_introductions')) return
  await resend.emails.send({
    from: 'Andrel <hello@andrel.app>',
    to: toEmail,
    subject: 'New introductions waiting for you',
    html: `
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1B2850; margin-bottom: 24px;">New introductions on Andrel</h2>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
          Hi ${toName},
        </p>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
          We've curated ${introCount} new ${introCount === 1 ? 'introduction' : 'introductions'} for you.
        </p>
        <a href="https://andrel.app/dashboard/introductions"
           style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
          Review introductions
        </a>
        <p style="color: #64748b; font-size: 14px; margin-top: 32px;">
          — The Andrel Team
        </p>
      </div>
    `,
  })
}

/**
 * Dedicated sender for an ADMIN-APPROVED batch that is visible now. Used ONLY by
 * approve-batch's visible recipients — the shared sendNewBatchEmail (weekly / onboarding /
 * promotion) is intentionally left unchanged.
 */
export async function sendAdminBatchReadyEmail(toEmail: string, toName: string) {
  if (!await isPrefEnabled(toEmail, 'email_new_introductions')) return
  await resend.emails.send({
    from: 'Andrel <hello@andrel.app>',
    to: toEmail,
    subject: 'You have new introductions waiting on Andrel',
    html: `
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1B2850; margin-bottom: 24px;">New introductions on Andrel</h2>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
          Hi ${toName},
        </p>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
          We've curated new introductions for you based on your profile and interests.<br/><br/>
          Log in to review your new connections and let us know which ones you'd like to pursue.
        </p>
        <a href="https://andrel.app/dashboard/introductions"
           style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
          Review Introductions
        </a>
        <p style="color: #64748b; font-size: 14px; margin-top: 32px;">
          — The Andrel Team
        </p>
      </div>
    `,
  })
}

/**
 * Sent when an admin batch was QUEUED behind a member's still-unresolved current batch.
 * Nudges them to finish their CURRENT introductions. Deliberately takes only email + name
 * (no counts, no target names) so it can never reveal the queued batch; links only to the
 * member's current introductions.
 */
export async function sendCurrentIntroductionsWaitingEmail(toEmail: string, toName: string) {
  if (!await isPrefEnabled(toEmail, 'email_new_introductions')) return
  await resend.emails.send({
    from: 'Andrel <hello@andrel.app>',
    to: toEmail,
    subject: 'Your Andrel introductions are waiting',
    html: `
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1B2850; margin-bottom: 24px;">Your introductions are waiting</h2>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
          Hi ${toName},
        </p>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
          You still have introductions waiting for you from your previous round.<br/><br/>
          Take a moment to Express Interest or Pass on each introduction — once you've reviewed them,
          we'll unlock your next curated introductions.
        </p>
        <a href="https://andrel.app/dashboard/introductions"
           style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
          Review Current Introductions
        </a>
        <p style="color: #64748b; font-size: 14px; margin-top: 32px;">
          — The Andrel Team
        </p>
      </div>
    `,
  })
}

/**
 * PART 3 — "Action needed" reminder for a member SKIPPED from the weekly refresh
 * because they still have unresolved introductions to review. Uses the existing email
 * infrastructure (Resend + the `email_new_introductions` preference gate). Returns a
 * result so the caller can report successes and failures separately; NEVER throws, so
 * a send failure can never alter eligibility or create a batch.
 */
export async function sendPendingIntrosReminderEmail(
  toEmail: string,
  toName: string,
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  try {
    if (!await isPrefEnabled(toEmail, 'email_new_introductions')) return { success: false, skipped: true }
    await resend.emails.send({
      from: 'Andrel <hello@andrel.app>',
      to: toEmail,
      subject: 'Action needed before your next introductions',
      html: `
        <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1B2850; margin-bottom: 24px;">Action needed before your next introductions</h2>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Hi ${toName},
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            You still have introductions waiting for your response.<br/><br/>
            Review them and choose either Interested or Pass.<br/><br/>
            Once you've responded, you'll automatically receive new introductions in the following batch.
          </p>
          <a href="https://andrel.app/dashboard/introductions"
             style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
            Review Introductions
          </a>
          <p style="color: #64748b; font-size: 14px; margin-top: 32px;">
            — The Andrel Team
          </p>
        </div>
      `,
    })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) }
  }
}

// Weekly reminder that a member still has unresolved introductions to review.
// Same category as new-introduction emails (email_new_introductions), so it is
// automatically suppressed once a member opts out of introduction emails.
export async function sendIntroductionReminderEmail(
  toEmail: string,
  toName: string,
  introCount: number,
  category: 'no_action' | 'partial' = 'no_action'
) {
  if (!await isPrefEnabled(toEmail, 'email_new_introductions')) return
  const copy = introReminderCopy(category, introCount)
  await resend.emails.send({
    from: 'Andrel <hello@andrel.app>',
    to: toEmail,
    subject: copy.subject,
    html: `
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1B2850; margin-bottom: 24px;">${copy.heading}</h2>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
          Hi ${toName},
        </p>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
          ${copy.body}
        </p>
        <a href="https://andrel.app/dashboard/introductions"
           style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
          ${copy.cta}
        </a>
        <p style="color: #64748b; font-size: 14px; margin-top: 32px;">
          — The Andrel Team
        </p>
      </div>
    `,
  })
}

// Nudge for a member whose counterpart already expressed interest and is now
// awaiting their response. Introduction-class email (email_new_introductions).
export async function sendWaitingResponseEmail(
  toEmail: string,
  toName: string
) {
  if (!await isPrefEnabled(toEmail, 'email_new_introductions')) return
  await resend.emails.send({
    from: 'Andrel <hello@andrel.app>',
    to: toEmail,
    subject: 'Someone is waiting on your response',
    html: `
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1B2850; margin-bottom: 24px;">Someone is waiting on your response</h2>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
          Hi ${toName},
        </p>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
          One of your introductions has expressed interest in connecting with you and is waiting to hear back.
          When you both express interest, Andrel makes the introduction. Take a look and let us know if it's a fit.
        </p>
        <a href="https://andrel.app/dashboard/introductions"
           style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
          Review Introductions
        </a>
        <p style="color: #64748b; font-size: 14px; margin-top: 32px;">
          — The Andrel Team
        </p>
      </div>
    `,
  })
}

/**
 * Secure account-access invitation — the ONLY invitation email going forward. Contains a
 * single-purpose, expiring, scanner-resistant set-password LINK and NO password. The link is
 * built by the trusted server (lib/invitations/secureInvite) and passed in here; it is never
 * logged or persisted. Returns provider acceptance + Resend message id for durable tracking.
 */
export async function sendSecureInviteEmail(args: {
  to: string
  toName: string
  link: string
  /** Named ONLY when the referrer explicitly consented to be shared (consent gate is enforced
   *  by the caller). Absent → anonymous invite copy. */
  referrerName?: string | null
  /** Stable key from the durable delivery claim id → passed to Resend so a retry with the same
   *  key is de-duplicated provider-side. */
  idempotencyKey?: string
}): Promise<{ success: boolean; messageId?: string; errorClass?: string; uncertain?: boolean }> {
  const firstName = ((args.toName || '').trim().split(/\s+/)[0]) || 'there'
  const recommendedBy = (args.referrerName || '').trim()
  const introLine = recommendedBy
    ? `${escapeHtml(recommendedBy)} recommended you for Andrel. Use the secure link below to set your password and finish setting up your account.`
    : `You've been invited to join Andrel. Use the secure link below to set your password and finish setting up your account.`
  try {
    const { data, error } = await resend.emails.send({
      from: 'Andrel <hello@andrel.app>',
      to: args.to,
      subject: 'Welcome to Andrel — set up your account',
      html: `
        <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; color:#334155;">
          <h2 style="color:#1B2850; margin-bottom:16px;">You're invited to Andrel</h2>
          <p style="font-size:16px; line-height:1.6;">Hi ${escapeHtml(firstName)},</p>
          <p style="font-size:16px; line-height:1.6;">${introLine}</p>
          <p style="margin:28px 0;">
            <a href="${args.link}" style="display:inline-block; background:#1B2850; color:#ffffff; text-decoration:none; font-size:16px; font-weight:600; padding:14px 32px; border-radius:10px;">Set up my account</a>
          </p>
          <p style="font-size:13px; color:#64748b; line-height:1.6;">
            This link is personal to you — please don't forward it. This secure link expires for your protection.
            If it no longer works, request a new link from the Andrel sign-in page.
          </p>
          <p style="font-size:13px; color:#64748b; line-height:1.6;">
            Don't see it? Check your spam/junk folder. Need help? Reply to this email or contact
            <a href="mailto:hello@andrel.app" style="color:#1B2850;">hello@andrel.app</a>.
          </p>
          <p style="font-size:13px; color:#94a3b8; margin-top:28px;">— The Andrel Team</p>
        </div>`,
      text:
        `You're invited to Andrel.\n\nHi ${firstName},\n\n` +
        `${recommendedBy ? `${recommendedBy} recommended you for Andrel.` : `You've been invited to join Andrel.`} Use the secure link below to set your password and finish setting up your account:\n\n` +
        `${args.link}\n\n` +
        `This link is personal to you — please don't forward it. This secure link expires for your protection; ` +
        `if it no longer works, request a new link from the Andrel sign-in page.\n\n` +
        `Don't see it? Check your spam/junk folder. Need help? Contact hello@andrel.app.\n\n— The Andrel Team`,
    }, args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : undefined)
    if (error) {
      // Definite provider rejection → NOT retryable as-is (safe failure).
      console.error('[sendSecureInviteEmail] Resend error:', error.message)
      return { success: false, errorClass: /rate|limit/i.test(error.message || '') ? 'rate_limited' : 'provider_error' }
    }
    return { success: true, messageId: data?.id }
  } catch (e: any) {
    // Network/timeout → UNCERTAIN outcome. Retry with the SAME idempotency key.
    console.error('[sendSecureInviteEmail] exception (uncertain):', e?.message)
    return { success: false, uncertain: true, errorClass: 'timeout' }
  }
}

/**
 * NOMINATION invitation — one individual nominee in To, the nominator CC'd. SECURE + PASSWORDLESS: the
 * `link` is a single-purpose /auth/recover setup link built by the trusted server (never a password, a
 * shared link, or a token echoed/logged). Exactly ONE nominee per send (no other nominee in To/CC/BCC).
 * The nominator (CC) is a courtesy copy only — delivery state is tracked against the To recipient (the
 * webhook applies events by `data.to`, ignoring the CC). Wording is preserved verbatim per the campaign.
 */
export { buildNominationInviteEmail } from '@/lib/email/nominationInvite'

/**
 * Send a nomination invitation. ONE nominee per send — `cc` is OPTIONAL and is the nominator only.
 * When omitted (a campaign whose nominator must not be copied) the message has exactly one recipient
 * and no cc/bcc key is passed to the provider at all. No campaign ever places two nominees on one
 * message, so a nominee can never be exposed to another.
 *
 * Defaults keep the original James Kahrs behaviour for callers that pass neither nominatorName,
 * intro, nor subject.
 */
export async function sendNominationInviteEmail(args: {
  to: string
  /** The nominator, courtesy-copied. OMIT entirely for campaigns that must not copy the nominator. */
  cc?: string
  firstName: string
  link: string
  idempotencyKey?: string
  nominatorName?: string
  intro?: string
  subject?: string
}): Promise<{ success: boolean; messageId?: string; errorClass?: string; uncertain?: boolean }> {
  const nominatorName = args.nominatorName ?? 'James Kahrs'
  const intro = args.intro ?? 'a private network for senior leaders across legal, government affairs, business, and executive leadership'
  const subject = args.subject ?? 'James Kahrs invited you to join Andrel'
  const built = buildNominationInviteEmail({ nominatorName, intro, firstName: args.firstName, link: args.link, subject })
  try {
    const { data, error } = await resend.emails.send({
      from: 'Andrel <hello@andrel.app>',
      to: args.to,
      // Only include a cc key when the campaign actually copies the nominator.
      ...(args.cc ? { cc: args.cc } : {}),
      subject: built.subject,
      html: built.html,
      text: built.text,
    }, args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : undefined)
    if (error) {
      console.error('[sendNominationInviteEmail] Resend error:', error.message)
      return { success: false, errorClass: /rate|limit/i.test(error.message || '') ? 'rate_limited' : 'provider_error' }
    }
    return { success: true, messageId: data?.id }
  } catch (e: any) {
    console.error('[sendNominationInviteEmail] exception (uncertain):', e?.message)
    return { success: false, uncertain: true, errorClass: 'timeout' }
  }
}


// Warm recommendation-introduction email — sent by the founder BEFORE any account
// is provisioned, to start the relationship. Deliberately plain-text with NO
// password, login button, credentials, or signup CTA — reply-based only, plus a
// privacy-management link. Account provisioning (the secure, passwordless invitation
// sent from the admin waitlist tools) is a SEPARATE, later step. Not preference-gated:
// the nominee has no account/preferences yet.
export async function sendRecommendationIntroductionEmail(
  toEmail: string,
  toName: string,
  recommenderName: string,
  manageUrl: string,
): Promise<{ success: boolean; error?: string }> {
  const { subject, text } = buildRecommendationIntroEmail({
    recommenderName,
    nomineeName: toName,
    manageUrl,
  })
  try {
    const { data, error } = await resend.emails.send({
      // Personal "from" (still a monitored address) so a reply reaches us.
      from: 'Daniel Abramoff <hello@andrel.app>',
      to: toEmail,
      subject,
      text, // plain-text only — no html, no marketing design
    })
    if (error) {
      console.error('[sendRecommendationIntroductionEmail] Resend API error:', error.message)
      return { success: false, error: error.message }
    }
    console.log('[sendRecommendationIntroductionEmail] sent, message ID:', data?.id)
    return { success: true }
  } catch (err: any) {
    console.error('[sendRecommendationIntroductionEmail] exception:', err?.message)
    return { success: false, error: err?.message }
  }
}


// Activation reminders bypass notification preferences — invited users haven't
// logged in yet, so they have no preference row, and these are bootstrap/access
// emails (the same bootstrap class as the secure invitation). They link only to the
// static /login page — no token or password. Reminders stop on first login.
export async function sendInviteReminder1(toEmail: string, toName: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { data, error } = await resend.emails.send({
      from: 'Andrel <hello@andrel.app>',
      to: toEmail,
      subject: 'Your Andrel access is waiting',
      html: `
        <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Hi ${escapeHtml(toName)},
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            You've been invited into Andrel's early network. Your access is ready when you are — set up (or reset) your secure sign-in below.
          </p>
          <a href="https://www.andrel.app/auth/forgot-password"
             style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
            Set up your access
          </a>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-top: 24px;">
            We'll email you a secure link to finish setting up — no password to remember. Once you're in, we'll begin curating relevant introductions for you.
          </p>
          <p style="color: #64748b; font-size: 14px; margin-top: 32px;">
            — The Andrel team
          </p>
        </div>
      `,
    })
    if (error) {
      console.error('[sendInviteReminder1] Resend API error:', error.message)
      return { success: false, error: error.message }
    }
    console.log('[sendInviteReminder1] sent, message ID:', data?.id)
    return { success: true }
  } catch (err: any) {
    console.error('[sendInviteReminder1] exception:', err?.message)
    return { success: false, error: err?.message }
  }
}

export async function sendInviteReminder2(toEmail: string, toName: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { data, error } = await resend.emails.send({
      from: 'Andrel <hello@andrel.app>',
      to: toEmail,
      subject: 'Reminder: your Andrel invitation',
      html: `
        <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Hi ${escapeHtml(toName)},
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            A brief reminder that your Andrel access is still available. We're opening the founding group in stages and would be glad to include you when you're ready. Set up (or reset) your secure sign-in below — we'll email you a link, no password to remember.
          </p>
          <a href="https://www.andrel.app/auth/forgot-password"
             style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
            Set up your access
          </a>
          <p style="color: #64748b; font-size: 14px; margin-top: 32px;">
            — The Andrel team
          </p>
        </div>
      `,
    })
    if (error) {
      console.error('[sendInviteReminder2] Resend API error:', error.message)
      return { success: false, error: error.message }
    }
    console.log('[sendInviteReminder2] sent, message ID:', data?.id)
    return { success: true }
  } catch (err: any) {
    console.error('[sendInviteReminder2] exception:', err?.message)
    return { success: false, error: err?.message }
  }
}

// Founding Member notification — one-time status email. Bypasses preferences
// (same class as invite/reminder emails: account-status, not configurable).
// The audit confirmed real benefits exist today (lib/tier-override.ts: 30
// credits/month, 60 credit cap, premium-opportunity access), so the body can
// mention them honestly. Founding intro cadence matches free (3), so the copy
// must not imply more or faster introductions.
export async function sendFoundingMemberEmail(toEmail: string, toName: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { data, error } = await resend.emails.send({
      from: 'Andrel <hello@andrel.app>',
      to: toEmail,
      subject: "You've been selected as an Andrel Founding Member",
      html: `
        <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Hi ${escapeHtml(toName)},
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            I wanted to reach out personally to let you know that you've been selected as an Andrel Founding Member.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            We're opening Andrel carefully, and Founding Members are the small group helping us shape the early network. As a Founding Member, you'll receive additional intro credits each month and access to premium opportunities ahead of the broader rollout.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            Andrel exists for meaningful, relationship-driven networking — not transactional outreach. Founding Members help us keep that culture intact as the network grows.
          </p>
          <a href="https://www.andrel.app/dashboard"
             style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
            Sign in to Andrel
          </a>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-top: 32px; margin-bottom: 16px;">
            Welcome to the founding group.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 4px;">
            — Daniel
          </p>
          <p style="color: #64748b; font-size: 14px;">
            Founder, Andrel
          </p>
        </div>
      `,
    })
    if (error) {
      console.error('[sendFoundingMemberEmail] Resend API error:', error.message)
      return { success: false, error: error.message }
    }
    console.log('[sendFoundingMemberEmail] sent, message ID:', data?.id)
    return { success: true }
  } catch (err: any) {
    console.error('[sendFoundingMemberEmail] exception:', err?.message)
    return { success: false, error: err?.message }
  }
}

// Shared date/time block for meeting emails. Shows the recipient's/scheduler's
// LOCAL time (with the real timezone abbreviation, e.g. EDT) AND the canonical
// UTC time, so the reader instantly sees their local time while still seeing UTC.
// When no distinct local time is available, only the UTC line renders (no
// regression from the prior single line). `datePrefix` lets the reschedule email
// prepend "Proposed: ". Labels are produced by lib/meetings/formatMeetingTime.
function meetingTimeBlockHtml(
  dateLabel: string,
  localLabel: string | null,
  utcLabel: string,
  datePrefix = '',
): string {
  return `
          <p style="color: #1B2850; font-weight: 600; margin: 0 0 6px 0;">📅 ${datePrefix}${dateLabel}</p>
          ${localLabel ? `<p style="color: #1B2850; font-weight: 600; margin: 0 0 4px 0;">🕕 ${localLabel} <span style="color:#64748b; font-weight:500;">(Local)</span></p>` : ''}
          <p style="color: #334155; font-weight: 600; margin: 0;">🌍 ${utcLabel}</p>`
}

export async function sendMeetingRequestEmail(
  toEmail: string,
  toName: string,
  fromName: string,
  dateLabel: string,
  localLabel: string | null,
  utcLabel: string,
  meetingPurpose?: string
) {
  if (!await isPrefEnabled(toEmail, 'email_meeting_updates')) return
  await resend.emails.send({
    from: 'Andrel <hello@andrel.app>',
    to: toEmail,
    subject: `Meeting request from ${fromName}`,
    html: `
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1B2850; margin-bottom: 24px;">New meeting request</h2>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
          Hi ${toName},
        </p>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
          <strong>${fromName}</strong> would like to meet with you.
        </p>
        <div style="background: #F5F6FB; border-left: 3px solid #1B2850; padding: 16px; margin: 24px 0; border-radius: 4px;">
          ${meetingTimeBlockHtml(dateLabel, localLabel, utcLabel)}
          ${meetingPurpose ? `<p style="color: #334155; margin: 12px 0 0 0;"><strong>Purpose:</strong> ${meetingPurpose}</p>` : ''}
        </div>
        <a href="https://andrel.app/dashboard/meetings"
           style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
          View Meeting Request
        </a>
        <p style="color: #64748b; font-size: 14px; margin-top: 32px;">
          — The Andrel Team
        </p>
      </div>
    `,
  })
}

export async function sendMeetingAcceptedEmail(
  toEmail: string,
  toName: string,
  acceptedByName: string,
  dateLabel: string,
  localLabel: string | null,
  utcLabel: string
) {
  if (!await isPrefEnabled(toEmail, 'email_meeting_updates')) return
  await resend.emails.send({
    from: 'Andrel <hello@andrel.app>',
    to: toEmail,
    subject: `${acceptedByName} accepted your meeting`,
    html: `
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1B2850; margin-bottom: 24px;">Meeting confirmed</h2>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
          Hi ${toName},
        </p>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
          <strong>${acceptedByName}</strong> has confirmed your meeting.
        </p>
        <div style="background: #F5F6FB; border-left: 3px solid #1B2850; padding: 16px; margin: 24px 0; border-radius: 4px;">
          ${meetingTimeBlockHtml(dateLabel, localLabel, utcLabel)}
        </div>
        <a href="https://andrel.app/dashboard/meetings"
           style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
          View Meeting Details
        </a>
        <p style="color: #64748b; font-size: 14px; margin-top: 32px;">
          — The Andrel Team
        </p>
      </div>
    `,
  })
}

export async function sendMeetingDeclinedEmail(
  toEmail: string,
  toName: string,
  declinedByName: string
) {
  if (!await isPrefEnabled(toEmail, 'email_meeting_updates')) return
  await resend.emails.send({
    from: 'Andrel <hello@andrel.app>',
    to: toEmail,
    subject: 'Meeting request declined',
    html: `
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1B2850; margin-bottom: 24px;">Meeting request declined</h2>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
          Hi ${toName},
        </p>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
          <strong>${declinedByName}</strong> is unable to accept your meeting request at this time.
        </p>
        <a href="https://andrel.app/dashboard/meetings"
           style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
          View Meetings
        </a>
        <p style="color: #64748b; font-size: 14px; margin-top: 32px;">
          — The Andrel Team
        </p>
      </div>
    `,
  })
}

export async function sendMeetingRescheduledEmail(
  toEmail: string,
  toName: string,
  reschedulerName: string,
  dateLabel: string,
  localLabel: string | null,
  utcLabel: string,
  meetingPurpose?: string
) {
  if (!await isPrefEnabled(toEmail, 'email_meeting_updates')) return
  await resend.emails.send({
    from: 'Andrel <hello@andrel.app>',
    to: toEmail,
    subject: `${reschedulerName} proposed a new meeting time`,
    html: `
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1B2850; margin-bottom: 24px;">Meeting reschedule request</h2>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
          Hi ${toName},
        </p>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
          <strong>${reschedulerName}</strong> has proposed a new time for your meeting.
        </p>
        <div style="background: #F5F6FB; border-left: 3px solid #1B2850; padding: 16px; margin: 24px 0; border-radius: 4px;">
          ${meetingTimeBlockHtml(dateLabel, localLabel, utcLabel, 'Proposed: ')}
          ${meetingPurpose ? `<p style="color: #334155; margin: 12px 0 0 0;"><strong>Meeting:</strong> ${meetingPurpose}</p>` : ''}
        </div>
        <a href="https://andrel.app/dashboard/meetings"
           style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
          Review Reschedule Request
        </a>
        <p style="color: #64748b; font-size: 14px; margin-top: 32px;">
          — The Andrel Team
        </p>
      </div>
    `,
  })
}

/**
 * Calendar invitation / cancellation for a CONFIRMED meeting — carries an RFC 5545
 * .ics attachment (METHOD:REQUEST or CANCEL) so Google/Outlook/Apple add or cancel the
 * event. Gated on the existing 'email_meeting_updates' preference (opt-out = handled, no
 * send). Throws on a provider failure so the caller can record a retryable failure.
 */
export async function sendCalendarInviteEmail(args: {
  to: string
  toName: string
  summary: string
  method: 'REQUEST' | 'CANCEL'
  scheduledAt: string
  scheduledTimezone?: string | null
  ics: string
  /** Aligned to the durable invite identity (uid:method:sequence:recipient) so a Resend
   *  retry with the same key is de-duplicated provider-side. */
  idempotencyKey?: string
}): Promise<void> {
  // NOTE: calendar invitations are TRANSACTIONAL meeting artifacts (the actual event a
  // confirmed participant adds to their calendar), NOT optional reminder/notification email.
  // They are therefore intentionally NOT gated by the email_meeting_updates preference,
  // which controls ordinary meeting-notification emails (request/accept/reschedule). Silently
  // suppressing the invite for a confirmed participant would deny them their calendar entry.
  const cancelled = args.method === 'CANCEL'
  const { dateLabel, localLabel, utcLabel } = formatMeetingTimes(args.scheduledAt, args.scheduledTimezone || undefined)
  await resend.emails.send({
    from: 'Andrel <hello@andrel.app>',
    to: args.to,
    subject: cancelled ? `Cancelled: ${args.summary}` : `Invitation: ${args.summary}`,
    html: `
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1B2850; margin-bottom: 24px;">${cancelled ? 'Meeting cancelled' : 'Meeting confirmed'}</h2>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">Hi ${args.toName},</p>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
          ${cancelled ? 'This meeting has been cancelled:' : 'Your meeting is confirmed:'}
        </p>
        ${meetingTimeBlockHtml(dateLabel, localLabel, utcLabel)}
        <p style="color: #334155; font-size: 15px; line-height: 1.6; margin: 16px 0 24px;">
          ${cancelled ? 'A cancellation has been sent to your calendar.' : 'A calendar invitation is attached — add it to Google, Outlook, or Apple Calendar.'}
        </p>
        <a href="https://andrel.app/dashboard/meetings"
           style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
          View on Andrel
        </a>
        <p style="color: #64748b; font-size: 14px; margin-top: 32px;">— The Andrel Team</p>
      </div>
    `,
    attachments: [{
      filename: cancelled ? 'cancel.ics' : 'invite.ics',
      content: Buffer.from(args.ics, 'utf-8'),
      contentType: `text/calendar; charset=utf-8; method=${args.method}`,
    }],
  }, args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : undefined)
}

export async function sendDigestEmail(
  toEmail: string,
  toName: string,
  unreadMessages: number,
  pendingMeetings: number
): Promise<{ success: boolean; error?: string }> {
  if (!await isPrefEnabled(toEmail, 'email_daily_digest')) return { success: true }
  const items: string[] = []
  if (unreadMessages > 0) {
    items.push(
      `<li style="margin-bottom: 8px;"><a href="https://andrel.app/dashboard/messages" style="color: #1B2850; font-weight: 600;">${unreadMessages} unread message${unreadMessages > 1 ? 's' : ''}</a></li>`
    )
  }
  if (pendingMeetings > 0) {
    items.push(
      `<li style="margin-bottom: 8px;"><a href="https://andrel.app/dashboard/meetings" style="color: #1B2850; font-weight: 600;">${pendingMeetings} meeting request${pendingMeetings > 1 ? 's' : ''} awaiting your response</a></li>`
    )
  }

  try {
    const { error } = await resend.emails.send({
      from: 'Andrel <hello@andrel.app>',
      to: toEmail,
      subject: 'Things waiting for you on Andrel',
      html: `
        <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1B2850; margin-bottom: 24px;">You have things waiting</h2>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">Hi ${escapeHtml(toName)},</p>
          <ul style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px; padding-left: 20px;">
            ${items.join('\n')}
          </ul>
          <a href="https://andrel.app/dashboard"
             style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
            Go to Andrel
          </a>
          <p style="color: #94a3b8; font-size: 12px; margin-top: 32px;">
            To stop receiving these, go to
            <a href="https://andrel.app/dashboard/settings" style="color: #94a3b8;">Settings</a>
            and turn off email notifications.
          </p>
        </div>
      `,
    })
    if (error) {
      console.error('[sendDigestEmail] error:', error)
      return { success: false, error: error.message }
    }
    return { success: true }
  } catch (err: any) {
    console.error('[sendDigestEmail] exception:', err)
    return { success: false, error: err.message }
  }
}

export async function sendWaitlistConfirmationEmail(
  toEmail: string,
  toName: string,
): Promise<{ success: boolean; error?: string }> {
  const firstName = toName.split(' ')[0]
  try {
    const { data, error } = await resend.emails.send({
      from: 'Andrel <hello@andrel.app>',
      to: toEmail,
      subject: "You're on the Andrel waitlist",
      html: `
        <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Hi ${escapeHtml(firstName)},
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Thanks for your interest in Andrel.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Andrel is a curated professional network designed to help attorneys, executives, consultants, and business leaders build more meaningful professional relationships through thoughtful introductions and high-signal networking.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Andrel's early members include senior in-house counsel, law firm attorneys, consultants, and executives, and we're intentionally onboarding members gradually to maintain a highly curated experience from the outset.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Your spot on the waitlist has been confirmed, and we'll reach out as access opens.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 32px;">
            Looking forward to having you involved.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6;">
            — Daniel Abramoff<br>
            <span style="color: #64748b; font-size: 14px;">Founder, Andrel</span>
          </p>
        </div>
      `,
    })
    if (error) {
      console.error('[waitlist-confirmation] Resend API error:', error.message)
      return { success: false, error: error.message }
    }
    console.log('[waitlist-confirmation] sent, message ID:', data?.id)
    return { success: true }
  } catch (err: any) {
    console.error('[waitlist-confirmation] exception:', err?.message)
    return { success: false, error: err?.message }
  }
}

// Bootstrap-class email to waitlist members announcing the platform is open.
// Bypasses isPrefEnabled (recipients have no profile / no preference row yet).
// Deliberately contains NO login link or CTA — recipients receive access separately
// via the secure, passwordless invitation (a scanner-resistant set-up link; never a
// credentials or password email).
export async function sendLaunchAnnouncementEmail(
  toEmail: string,
  toName: string,
): Promise<{ success: boolean; error?: string }> {
  const firstName = (toName?.split(' ')[0] || 'there')
  try {
    const { data, error } = await resend.emails.send({
      from: 'Andrel <hello@andrel.app>',
      to: toEmail,
      subject: 'Andrel Is Officially Open',
      html: `
        <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Hi ${escapeHtml(firstName)},
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Thank you for joining the Andrel waitlist.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Today, we're excited to officially launch the platform and begin welcoming our founding members.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Andrel was built around a simple idea: the most valuable professional connections are rarely made through cold outreach. They come from trusted introductions to the right people at the right time.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            As a founding member, you'll be among the first professionals invited into this private network.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 8px;">
            Through Andrel, you can expect:
          </p>
          <ul style="color: #334155; font-size: 16px; line-height: 1.7; margin: 0 0 24px 0; padding-left: 24px; list-style-type: disc;">
            <li style="margin-bottom: 8px;">Meaningful introductions to potential colleagues</li>
            <li style="margin-bottom: 8px;">Business development through trusted relationships</li>
            <li style="margin-bottom: 8px;">Career advancement and professional growth</li>
            <li style="margin-bottom: 8px;">Strategic partnerships and collaborations</li>
          </ul>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Over the next few days, you'll receive a separate email with your login credentials and instructions for accessing the platform.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            We're onboarding members in phases to ensure every introduction is thoughtful, relevant, and of the highest quality.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Thank you for helping shape Andrel from the very beginning. We look forward to connecting you with exceptional people, valuable relationships, and meaningful collaborations.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 32px;">
            Welcome to Andrel.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6;">
            Best,<br>
            Daniel Abramoff<br>
            <span style="color: #64748b; font-size: 14px;">Founder, Andrel</span>
          </p>
        </div>
      `,
    })
    if (error) {
      console.error('[launch-announcement] Resend API error:', error.message)
      return { success: false, error: error.message }
    }
    console.log('[launch-announcement] sent, message ID:', data?.id)
    return { success: true }
  } catch (err: any) {
    console.error('[launch-announcement] exception:', err?.message)
    return { success: false, error: err?.message }
  }
}

// Canonical production destination for the referral-campaign CTA. Points at the
// authenticated recommend page (an alias that redirects to the existing referral
// form); a logged-out click lands on login, never a new-account flow.
export const RECOMMEND_MEMBER_CTA_URL = 'https://www.andrel.app/dashboard/recommend-member'

/**
 * One-time "Help us grow the Andrel network" campaign email, asking an existing
 * member to recommend a strong potential member. Sends nothing to the recommended
 * person — the CTA opens the member's own authenticated recommend page. `toName`
 * is split to a first name (defaults to "there"). Returns {success} so the caller
 * marks the member as sent ONLY on a provider-accepted send (idempotent campaign).
 */
export async function sendReferralRequestEmail(
  toEmail: string,
  toName: string,
): Promise<{ success: boolean; error?: string }> {
  const firstName = (toName?.split(' ')[0] || 'there')
  try {
    const { data, error } = await resend.emails.send({
      from: 'Daniel Abramoff <hello@andrel.app>',
      to: toEmail,
      subject: 'Who should be in this room?',
      // Reuse the existing preference system as the unsubscribe mechanism: the
      // List-Unsubscribe header + the footer link both point at /dashboard/settings,
      // where a member toggles email_product_updates (honored by the campaign's
      // eligibility filter). No custom unsubscribe system is introduced.
      headers: {
        'List-Unsubscribe': '<mailto:hello@andrel.app?subject=unsubscribe>, <https://www.andrel.app/dashboard/settings>',
      },
      html: `
        <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Hi ${escapeHtml(firstName)},
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Andrel grows by judgment rather than volume, which means the people already in it help shape what it becomes.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            If someone comes to mind, I'd love to hear who.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Every recommendation is personally reviewed before any invitation goes out.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            If you choose to allow it, we'll mention that you recommended them. Otherwise your recommendation remains private.
          </p>
          <div style="margin: 0 0 28px 0;">
            <a href="${RECOMMEND_MEMBER_CTA_URL}"
               style="display: inline-block; background: #1B2850; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; padding: 12px 24px; border-radius: 8px;">
              Recommend someone
            </a>
          </div>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 32px;">
            Thank you for helping shape this.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6;">
            Daniel
          </p>
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 32px 0 16px;" />
          <p style="color: #94a3b8; font-size: 12px; line-height: 1.5;">
            You're receiving this as an Andrel member.
            <a href="https://www.andrel.app/dashboard/settings" style="color: #94a3b8; text-decoration: underline;">Manage your email preferences</a>.
          </p>
        </div>
      `,
    })
    if (error) {
      console.error('[referral-campaign] Resend API error:', error.message)
      return { success: false, error: error.message }
    }
    console.log('[referral-campaign] sent, message ID:', data?.id)
    return { success: true }
  } catch (err: any) {
    console.error('[referral-campaign] exception:', err?.message)
    return { success: false, error: err?.message }
  }
}

// Canonical production destination for the first-matching-round reminder CTA.
// An invited member follows this into the normal password login → onboarding
// flow. It is NOT a tokenized/personalized link (the app authenticates with a
// password, so a generic login URL is the correct, safe destination) and it
// never creates a new account.
export const FIRST_MATCHING_REMINDER_CTA_URL = 'https://www.andrel.app/login'

/**
 * One-time "first matching round" reminder for invited members who have not yet
 * completed onboarding. `firstName` must already be a safe, non-blank display
 * value (callers use firstNameOrThere()); it is defensively re-defaulted to
 * "there" so a blank can never render.
 */
export async function sendFirstMatchingRoundReminderEmail(
  toEmail: string,
  firstName: string,
): Promise<{ success: boolean; error?: string }> {
  const name = (firstName || '').trim() || 'there'
  const url = FIRST_MATCHING_REMINDER_CTA_URL
  const preview = 'Complete your Andrel profile to be considered for the first round of matching.'
  const p = 'color: #334155; font-size: 16px; line-height: 1.6; margin: 0 0 16px 0;'
  try {
    const { data, error } = await resend.emails.send({
      from: 'Andrel <hello@andrel.app>',
      to: toEmail,
      subject: 'Your first introductions go out Tuesday',
      text:
`Hi ${name},

The first round of curated Andrel introductions goes out this Tuesday, July 21 — and I wanted to make sure you have the opportunity to be considered.

You're on the invite list, but your profile isn't complete yet. Members who finish their profiles before Tuesday can be considered for this first round of matching.

A note on how Andrel works: every introduction is curated for relevance and mutual fit — never cold outreach and never a public directory. Your profile is what allows us to identify the strongest potential matches for you.

Complete your profile: ${url}

It only takes a few minutes, and completing it before Tuesday gives you the opportunity to be included in the first matching round.

Looking forward to welcoming you,

Daniel Abramoff
Founder, Andrel`,
      html: `
        <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${preview}</div>
        <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
          <p style="${p}">Hi ${escapeHtml(name)},</p>
          <p style="${p}">The first round of curated Andrel introductions goes out this <strong>Tuesday, July 21</strong> — and I wanted to make sure you have the opportunity to be considered.</p>
          <p style="${p}">You're on the invite list, but your profile isn't complete yet. Members who finish their profiles before Tuesday can be considered for this first round of matching.</p>
          <p style="${p}">A note on how Andrel works: every introduction is curated for relevance and mutual fit — never cold outreach and never a public directory. Your profile is what allows us to identify the strongest potential matches for you.</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 28px 0;">
            <tr>
              <td align="center" bgcolor="#1B2850" style="border-radius: 8px;">
                <a href="${url}" style="display:inline-block; padding: 14px 30px; color:#ffffff; font-size:16px; font-weight:700; text-decoration:none; border-radius:8px; font-family: system-ui, -apple-system, sans-serif;">Complete Your Profile →</a>
              </td>
            </tr>
          </table>
          <p style="${p}">It only takes a few minutes, and completing it before Tuesday gives you the opportunity to be included in the first matching round.</p>
          <p style="${p}">Looking forward to welcoming you,</p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin: 0;">
            Daniel Abramoff<br>
            <span style="color: #64748b; font-size: 14px;">Founder, Andrel</span>
          </p>
          <p style="color: #94a3b8; font-size: 13px; line-height: 1.5; margin: 28px 0 0 0;">
            If the button doesn't work, copy and paste this link into your browser:<br>
            <a href="${url}" style="color: #1B2850;">${url}</a>
          </p>
        </div>
      `,
    })
    if (error) {
      console.error('[first-matching-reminder] Resend API error:', error.message)
      return { success: false, error: error.message }
    }
    console.log('[first-matching-reminder] sent, message ID:', data?.id)
    return { success: true }
  } catch (err: any) {
    console.error('[first-matching-reminder] exception:', err?.message)
    return { success: false, error: err?.message }
  }
}

export async function sendAdminAlertEmail(subject: string, htmlBody: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await resend.emails.send({
      from: 'Andrel <hello@andrel.app>',
      to: 'bizdev91@gmail.com',
      subject: `[Andrel Admin] ${subject}`,
      html: `
        <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
          ${htmlBody}
          <p style="color: #64748b; font-size: 14px; margin-top: 32px;">— The Andrel Team</p>
        </div>
      `,
    })
    if (error) {
      console.error('[sendAdminAlertEmail] error:', error)
      return { success: false, error: error.message }
    }
    return { success: true }
  } catch (err: any) {
    console.error('[sendAdminAlertEmail] exception:', err)
    return { success: false, error: err.message }
  }
}


/**
 * Wednesday unanswered-introduction reminder.
 *
 * Unlike the older senders this RETURNS the provider message id, because migration 065's delivery
 * ledger records it. A thrown provider error is surfaced to the caller so the ledger can mark the
 * attempt retryable — swallowing it would leave a claim that never resolves and a member who is
 * never reminded.
 *
 * The builder receives only a first name and a count, so no connection identity can reach the body.
 */
export async function sendWednesdayIntroReminderEmail(
  toEmail: string,
  firstName: string | null,
  openCount: number,
): Promise<{ sent: boolean; providerMessageId: string | null }> {
  if (!await isPrefEnabled(toEmail, 'email_new_introductions')) return { sent: false, providerMessageId: null }
  const { buildWednesdayReminderEmail } = await import('@/lib/email/wednesdayReminder')
  const built = buildWednesdayReminderEmail(firstName, openCount)
  const res = await resend.emails.send({
    from: 'Andrel <hello@andrel.app>',
    to: toEmail,
    subject: built.subject,
    html: built.html,
    text: built.text,
  })
  if ((res as any)?.error) throw new Error('provider_error')
  return { sent: true, providerMessageId: (res as any)?.data?.id ?? null }
}
