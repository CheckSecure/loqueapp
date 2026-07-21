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
  tempPassword: string,
  // Optional (defaults false, so existing callers are unaffected). When true, a
  // brief founding-member note is rendered. Callers that know the invitee's
  // founding status pass it through; those that don't get accurate non-founding
  // copy. This threads EXISTING data into the template — no new required var,
  // no invitation-logic change.
  isFoundingMember: boolean = false
) {
  // Personalization from the only name we have (full name) — no new variable.
  const firstName = ((toName || '').trim().split(/\s+/)[0]) || 'there'
  const loginUrl = 'https://www.andrel.app/login'

  // Andrel brand palette (tailwind.config.ts): navy #1B2850, gold #C4922A,
  // cream #F5F6FB, gold-soft #FDF3E3.
  const bodyFont = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
  const serifFont = "Georgia, 'Times New Roman', Times, serif"

  const steps = [
    'Complete your profile so we understand your background, expertise, interests, and goals.',
    'Receive curated introductions to professionals who align with them.',
    "Review each introduction and decide whether you're interested.",
    'When both people express interest, Andrel makes the introduction.',
  ]
  const stepsHtml = steps.map((s, i) => `
              <tr>
                <td valign="top" style="width:30px;padding:6px 14px 6px 0;">
                  <div style="width:26px;height:26px;line-height:26px;text-align:center;background:#1B2850;color:#ffffff;border-radius:50%;font-family:${serifFont};font-size:13px;font-weight:600;">${i + 1}</div>
                </td>
                <td valign="top" style="padding:6px 0;font-family:${bodyFont};font-size:15px;line-height:1.6;color:#3a4356;">${s}</td>
              </tr>`).join('')

  const foundingBlockHtml = isFoundingMember ? `
          <tr>
            <td class="px" style="padding:26px 48px 0 48px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FDF3E3;border:1px solid #F0DEB8;border-radius:12px;">
                <tr><td style="padding:16px 20px;font-family:${bodyFont};font-size:14px;line-height:1.6;color:#7a5a15;">
                  <span style="color:#9a6f12;font-weight:700;">As a founding member,</span> you'll receive additional introduction credits and early access to new features as Andrel continues to grow.
                </td></tr>
              </table>
            </td>
          </tr>` : ''

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Welcome to Andrel</title>
  <style>
    @media only screen and (max-width:620px) {
      .card { width:100% !important; border-radius:0 !important; }
      .px { padding-left:26px !important; padding-right:26px !important; }
      .cta a { display:block !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#F5F6FB;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#F5F6FB;">A private, invitation-only network for high-value professional introductions.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F6FB;margin:0;padding:0;">
    <tr>
      <td align="center" style="padding:36px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" class="card" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #ECEEF6;border-radius:16px;">
          <!-- Brand mark -->
          <tr>
            <td class="px" style="padding:44px 48px 0 48px;">
              <div style="font-family:${serifFont};font-size:15px;letter-spacing:6px;text-transform:uppercase;color:#1B2850;font-weight:700;">Andrel</div>
              <div style="width:46px;height:2px;background:#C4922A;margin-top:14px;font-size:0;line-height:0;">&nbsp;</div>
            </td>
          </tr>
          <!-- Headline -->
          <tr>
            <td class="px" style="padding:30px 48px 0 48px;">
              <h1 style="margin:0;font-family:${serifFont};font-size:30px;line-height:1.25;letter-spacing:-0.2px;color:#1B2850;font-weight:600;">Welcome to Andrel</h1>
            </td>
          </tr>
          <!-- Body copy -->
          <tr>
            <td class="px" style="padding:22px 48px 0 48px;font-family:${bodyFont};font-size:16px;line-height:1.75;color:#3a4356;">
              <p style="margin:0 0 18px 0;">Hi ${escapeHtml(firstName)},</p>
              <p style="margin:0 0 18px 0;">I'm glad you're joining our community.</p>
              <p style="margin:0 0 18px 0;">Andrel is a private, invitation-only network built around one simple idea: the right introduction at the right time can create enormous value.</p>
              <p style="margin:0 0 18px 0;">Instead of relying on cold outreach or endless networking, Andrel curates a small number of thoughtful introductions between professionals who are genuinely likely to benefit from knowing one another. Introductions are informed by each member's background, expertise, interests, and goals, with an emphasis on relevance and mutual value.</p>
              <p style="margin:0;">Our community brings together senior legal professionals—including in-house counsel, law firm attorneys, legal and compliance leaders, government affairs professionals, and other accomplished executives looking to build valuable long-term relationships.</p>
            </td>
          </tr>
          <!-- How it works -->
          <tr>
            <td class="px" style="padding:30px 48px 0 48px;">
              <div style="font-family:${bodyFont};font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#C4922A;font-weight:700;margin-bottom:14px;">How it works</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${stepsHtml}
              </table>
            </td>
          </tr>${foundingBlockHtml}
          <!-- Primary CTA -->
          <tr>
            <td class="px cta" align="center" style="padding:38px 48px 6px 48px;">
              <a href="${loginUrl}" style="display:inline-block;background:#1B2850;color:#ffffff;text-decoration:none;font-family:${bodyFont};font-size:16px;font-weight:600;padding:15px 40px;border-radius:10px;letter-spacing:0.2px;">Log in to Andrel</a>
            </td>
          </tr>
          <!-- Sign-in details -->
          <tr>
            <td class="px" style="padding:26px 48px 0 48px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F6FB;border:1px solid #E4E7F2;border-radius:12px;">
                <tr><td style="padding:20px 22px;font-family:${bodyFont};">
                  <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#8a93a6;font-weight:700;margin-bottom:14px;">Your sign-in details</div>
                  <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#8a93a6;margin-bottom:3px;">Email</div>
                  <div style="font-size:15px;color:#1B2850;font-weight:600;margin-bottom:14px;word-break:break-all;">${escapeHtml(toEmail)}</div>
                  <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#8a93a6;margin-bottom:3px;">Temporary password</div>
                  <div style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:17px;color:#1B2850;font-weight:700;letter-spacing:1px;">${escapeHtml(tempPassword)}</div>
                </td></tr>
              </table>
            </td>
          </tr>
          <!-- Login guidance (preserved) -->
          <tr>
            <td class="px" style="padding:16px 48px 0 48px;font-family:${bodyFont};font-size:13px;line-height:1.6;color:#8a93a6;">
              After logging in you'll be prompted to set your own password. If you received any earlier magic sign-in or password-reset links, please disregard them — they may have expired. Just use the email address and temporary password above.
            </td>
          </tr>
          <!-- Sign-off -->
          <tr>
            <td class="px" style="padding:30px 48px 0 48px;font-family:${bodyFont};font-size:16px;line-height:1.75;color:#3a4356;">
              <p style="margin:0 0 22px 0;">I'd genuinely value your feedback as you explore Andrel. Your input will help shape where we take the platform from here.</p>
              <p style="margin:0;">Best,<br>
                <span style="color:#1B2850;font-weight:600;">Daniel Abramoff</span><br>
                <span style="color:#8a93a6;font-size:14px;">Founder, Andrel</span>
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td class="px" style="padding:34px 48px 42px 48px;">
              <div style="height:1px;background:#ECEEF6;font-size:0;line-height:0;margin-bottom:20px;">&nbsp;</div>
              <div style="font-family:${bodyFont};font-size:12px;line-height:1.6;color:#a8b0c0;">Andrel · A private, invitation-only network for high-value professional introductions.</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  const foundingText = isFoundingMember
    ? "\nAs a founding member, you'll receive additional introduction credits and early access to new features as Andrel continues to grow.\n"
    : ''

  const text = `Welcome to Andrel

Hi ${firstName},

I'm glad you're joining our community.

Andrel is a private, invitation-only network built around one simple idea: the right introduction at the right time can create enormous value.

Instead of relying on cold outreach or endless networking, Andrel curates a small number of thoughtful introductions between professionals who are genuinely likely to benefit from knowing one another. Introductions are informed by each member's background, expertise, interests, and goals, with an emphasis on relevance and mutual value.

Our community brings together senior legal professionals—including in-house counsel, law firm attorneys, legal and compliance leaders, government affairs professionals, and other accomplished executives looking to build valuable long-term relationships.

How it works:
1. ${steps[0]}
2. ${steps[1]}
3. ${steps[2]}
4. ${steps[3]}
${foundingText}
YOUR SIGN-IN DETAILS
Log in: ${loginUrl}
Email: ${toEmail}
Temporary password: ${tempPassword}

After logging in you'll be prompted to set your own password. If you received any earlier magic sign-in or password-reset links, please disregard them — they may have expired. Just use the email address and temporary password above.

I'd genuinely value your feedback as you explore Andrel. Your input will help shape where we take the platform from here.

Best,
Daniel Abramoff
Founder, Andrel`

  try {
    const { data, error } = await resend.emails.send({
      from: 'Andrel <hello@andrel.app>',
      to: toEmail,
      subject: 'Welcome to Andrel',
      html,
      text,
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
