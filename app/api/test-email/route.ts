import { NextResponse } from 'next/server'

export async function GET() {
  const apiKey = process.env.RESEND_API_KEY

  if (!apiKey) {
    return NextResponse.json({ error: 'RESEND_API_KEY is not set' }, { status: 500 })
  }

  console.log('[test-email] RESEND_API_KEY present:', !!apiKey)
  console.log('[test-email] key prefix (first 8 chars):', apiKey.slice(0, 8))

  const payload = {
    from: 'Loque <hello@loqueapp.com>',
    to: ['bizdev91@gmail.com'],
    subject: 'Loque test email',
    html: '<p>This is a test email from the Loque invite system. If you see this, Resend is working.</p>',
  }

  console.log('[test-email] sending with payload:', JSON.stringify(payload))

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    let body: string
    try { body = await res.text() } catch { body = '(unreadable)' }

    console.log('[test-email] Resend status:', res.status)
    console.log('[test-email] Resend full body:', body)

    return NextResponse.json({
      status: res.status,
      ok: res.ok,
      resend_response: JSON.parse(body),
      key_prefix: apiKey.slice(0, 8),
    }, { status: res.ok ? 200 : res.status })
  } catch (err: any) {
    console.error('[test-email] fetch threw:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
