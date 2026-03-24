const RESEND_API_KEY = process.env.RESEND_API_KEY

export async function sendInviteEmail(
  to: string,
  name: string,
  tempPassword: string,
): Promise<{ success: boolean; error?: string }> {
  if (!RESEND_API_KEY) {
    console.error('[email] RESEND_API_KEY not set — cannot send invite email')
    return { success: false, error: 'Email service not configured' }
  }

  const loginUrl = 'https://andrel.app/login'

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#f5f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6fb;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1B2850,#2E4080);padding:32px 40px;">
              <p style="margin:0;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">Andrel</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#C4922A;text-transform:uppercase;letter-spacing:1px;">Your invitation is ready</p>
              <h1 style="margin:0 0 16px;font-size:26px;font-weight:800;color:#0f172a;line-height:1.2;">You're in, ${name}.</h1>
              <p style="margin:0 0 24px;font-size:15px;color:#64748b;line-height:1.6;">
                We've reviewed your application and we're pleased to invite you to join Andrel — the professional network built on trust and warm introductions.
              </p>
              <p style="margin:0 0 8px;font-size:15px;color:#64748b;line-height:1.6;">Use these credentials to sign in and complete your profile:</p>
              <!-- Credentials box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 32px;">
                <tr>
                  <td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;">
                    <p style="margin:0 0 8px;font-size:13px;color:#94a3b8;">Email</p>
                    <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#0f172a;">${to}</p>
                    <p style="margin:0 0 8px;font-size:13px;color:#94a3b8;">Temporary password</p>
                    <p style="margin:0;font-size:18px;font-weight:800;color:#1B2850;letter-spacing:1px;">${tempPassword}</p>
                  </td>
                </tr>
              </table>
              <!-- CTA -->
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#1B2850;border-radius:10px;">
                    <a href="${loginUrl}" style="display:inline-block;padding:14px 32px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">
                      Sign in to Andrel →
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0;font-size:13px;color:#94a3b8;line-height:1.6;">
                After signing in you'll be asked to complete your profile. You can change your password in your profile settings at any time.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 40px;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                © ${new Date().getFullYear()} Andrel. You received this because you applied to join our waitlist.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  const FROM = 'Andrel <hello@andrel.app>'
  console.log('[email] sending invite — from:', FROM, 'to:', to)

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject: `You're invited to join Andrel`,
        html,
      }),
    })

    let body: string
    try {
      body = await res.text()
    } catch {
      body = '(could not read response body)'
    }

    console.log('[email] Resend status:', res.status)
    console.log('[email] Resend full response body:', body)

    if (!res.ok) {
      console.error('[email] Resend rejected the request — status:', res.status, '— body:', body)
      return { success: false, error: `Email API error: ${res.status} — ${body}` }
    }

    console.log('[email] invite sent successfully to:', to)
    return { success: true }
  } catch (err: any) {
    console.error('[email] fetch threw:', err.message)
    return { success: false, error: err.message }
  }
}
