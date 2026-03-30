import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

export async function sendMatchCreatedEmail(
  toEmail: string,
  toName: string,
  matchName: string,
  matchRole?: string,
  matchCompany?: string
) {
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
  await resend.emails.send({
    from: 'Andrel <hello@andrel.app>',
    to: toEmail,
    subject: 'New introductions waiting for you',
    html: `
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1B2850; margin-bottom: 24px;">Your weekly introductions are here</h2>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
          Hi ${toName},
        </p>
        <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
          We've curated ${introCount} new ${introCount === 1 ? 'introduction' : 'introductions'} for you this week.
        </p>
        <a href="https://andrel.app/dashboard/introductions" 
           style="display: inline-block; background: #1B2850; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600;">
          View Introductions
        </a>
        <p style="color: #64748b; font-size: 14px; margin-top: 32px;">
          — The Andrel Team
        </p>
      </div>
    `,
  })
}
