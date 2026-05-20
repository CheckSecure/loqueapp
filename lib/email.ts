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
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
            Your temporary password is:
          </p>
          <div style="background: #F5F6FB; border: 2px solid #1B2850; padding: 16px; margin: 24px 0; border-radius: 8px; text-align: center;">
            <code style="color: #1B2850; font-size: 18px; font-weight: 700; letter-spacing: 2px;">
              ${tempPassword}
            </code>
          </div>
          <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
            Please log in and change your password immediately.
          </p>
          <a href="https://andrel.app/login" 
             style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
            Log In to Andrel
          </a>
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
            <p style="color: #334155; font-size: 15px; margin: 0 0 8px 0;"><strong>Email:</strong> ${toEmail}</p>
            <p style="color: #334155; font-size: 15px; margin: 0;"><strong>Temporary password:</strong> <code style="color: #1B2850; font-weight: 700; letter-spacing: 1px;">${tempPassword}</code></p>
          </div>
          <a href="https://andrel.app/login"
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

// NOTE: sendWaitlistConfirmationEmail is currently NOT called by the waitlist
// signup path — disabled for V1 to mitigate SA2 (outbound-spam via the
// public waitlist form). The function is retained for future re-enable
// after verified-email or rate-limiting exists.
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
