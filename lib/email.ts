import { Resend } from 'resend'
import { createAdminClient } from '@/lib/supabase/admin'

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

export async function sendInviteEmail(
  toEmail: string,
  toName: string,
  tempPassword: string
) {
  try {
    const { data, error } = await resend.emails.send({
      from: 'Andrel <hello@andrel.app>',
      to: toEmail,
      subject: 'Welcome to Andrel',
      html: `
        <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1B2850; margin-bottom: 24px;">Welcome to Andrel</h2>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Hi ${toName},
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            You've been invited to join Andrel, a curated platform for high-value professional introductions.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 8px;">
            Sign in at <a href="https://www.andrel.app/login" style="color: #1B2850; font-weight: 600;">www.andrel.app/login</a> with:
          </p>
          <div style="background: #F5F6FB; border: 2px solid #1B2850; padding: 16px; margin: 12px 0 24px 0; border-radius: 8px;">
            <p style="margin: 0 0 8px 0; color: #334155; font-size: 15px;"><strong>Email:</strong> ${escapeHtml(toEmail)}</p>
            <p style="margin: 0; color: #334155; font-size: 15px;"><strong>Temporary password:</strong> <code style="color: #1B2850; font-size: 16px; font-weight: 700; letter-spacing: 1px;">${tempPassword}</code></p>
          </div>
          <a href="https://www.andrel.app/login"
             style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
            Log In to Andrel
          </a>
          <p style="color: #64748b; font-size: 14px; line-height: 1.6; margin-top: 24px;">
            After logging in you'll be prompted to set your own password. If you received any earlier magic sign-in or password-reset links, please disregard them — they may have expired. Just use the email address and temporary password above.
          </p>
          <p style="color: #64748b; font-size: 14px; margin-top: 32px;">
            — The Andrel Team
          </p>
        </div>
      `,
    })
    
    if (error) {
      console.error('[sendInviteEmail] Resend API error:', JSON.stringify(error, null, 2))
      console.error('[sendInviteEmail] Error details - name:', error.name, 'message:', error.message)
      return { success: false, error: error.message }
    }
    
    console.log('[sendInviteEmail] Resend success, message ID:', data?.id)
    return { success: true }
  } catch (error: any) {
    console.error('[sendInviteEmail] exception:', error)
    return { success: false, error: error.message }
  }
}

export async function sendReferralInviteEmail(
  toEmail: string,
  toName: string,
  tempPassword: string,
  referrerName: string
) {
  try {
    const { data, error } = await resend.emails.send({
      from: 'Andrel <hello@andrel.app>',
      to: toEmail,
      subject: "You've been invited to Andrel",
      html: `
        <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1B2850; margin-bottom: 24px;">You've been invited to Andrel</h2>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Hi ${toName},
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            ${referrerName} thought you'd be a strong addition to Andrel.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            Andrel is a curated professional network focused on high-quality introductions — no feeds, no cold outreach, just relevant connections with people worth meeting.
          </p>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Your account is ready. Use the credentials below to sign in:
          </p>
          <div style="background: #F5F6FB; border: 2px solid #1B2850; padding: 16px; margin: 24px 0; border-radius: 8px;">
            <p style="color: #334155; font-size: 15px; margin: 0 0 8px 0;"><strong>Email:</strong> ${escapeHtml(toEmail)}</p>
            <p style="color: #334155; font-size: 15px; margin: 0;"><strong>Temporary password:</strong> <code style="color: #1B2850; font-weight: 700; letter-spacing: 1px;">${tempPassword}</code></p>
          </div>
          <a href="https://www.andrel.app/login"
             style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
            Log In to Andrel
          </a>
          <p style="color: #64748b; font-size: 14px; margin-top: 32px;">
            Daniel
          </p>
        </div>
      `,
    })

    if (error) {
      console.error('[sendReferralInviteEmail] Resend API error:', JSON.stringify(error, null, 2))
      return { success: false, error: error.message }
    }

    console.log('[sendReferralInviteEmail] Resend success, message ID:', data?.id)
    return { success: true }
  } catch (error: any) {
    console.error('[sendReferralInviteEmail] exception:', error)
    return { success: false, error: error.message }
  }
}

// Activation reminders bypass notification preferences — invited users haven't
// logged in yet, so they have no preference row, and these are bootstrap/access
// emails (same class as sendInviteEmail above). Reminders stop on first login.
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
            You've been invited into Andrel's early network. Your access is ready when you are.
          </p>
          <a href="https://www.andrel.app/login"
             style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
            Sign in
          </a>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-top: 24px;">
            Once you sign in, we'll begin curating relevant introductions for you.
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
            A brief reminder that your Andrel access is still available. We're opening the founding group in stages and would be glad to include you when you're ready.
          </p>
          <a href="https://www.andrel.app/login"
             style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
            Sign in
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

export async function sendMeetingRequestEmail(
  toEmail: string,
  toName: string,
  fromName: string,
  meetingDate: string,
  meetingTime: string,
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
          <p style="color: #1B2850; font-weight: 600; margin: 0 0 8px 0;">📅 ${meetingDate} at ${meetingTime}</p>
          ${meetingPurpose ? `<p style="color: #334155; margin: 0;"><strong>Purpose:</strong> ${meetingPurpose}</p>` : ''}
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
  meetingDate: string,
  meetingTime: string
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
          <p style="color: #1B2850; font-weight: 600; margin: 0;">📅 ${meetingDate} at ${meetingTime}</p>
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
  newDate: string,
  newTime: string,
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
          <p style="color: #1B2850; font-weight: 600; margin: 0 0 8px 0;">📅 Proposed: ${newDate} at ${newTime}</p>
          ${meetingPurpose ? `<p style="color: #334155; margin: 0;"><strong>Meeting:</strong> ${meetingPurpose}</p>` : ''}
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
// Deliberately contains NO login link or CTA — recipients are told a separate
// credentials email will follow, which is the existing sendInviteEmail flow.
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
