import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifyResendWebhook, mapResendEvent } from '@/lib/webhooks/resendVerify'
import { applyDeliveryEvent } from '@/lib/invitations/delivery'

export const dynamic = 'force-dynamic'

/**
 * POST /api/webhooks/resend — Resend delivery webhook.
 *
 * Verifies the signature with the OFFICIAL Resend SDK (resend.webhooks.verify — Svix under the
 * hood) using the RAW body BEFORE any JSON parsing; an invalid/missing signature → 401. Then
 * applies the event replay- + ordering-safely (unique svix_id, event-created ordering, terminal
 * no-regress). Never logs the raw body, headers, secret, recipient, subject, link, or token.
 */
export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET
  const raw = await request.text() // read exactly once; pass untouched

  const evt = verifyResendWebhook(raw, request.headers, secret ?? '')
  if (!evt) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }

  const svixId = request.headers.get('svix-id')
  const status = mapResendEvent(evt.type)
  if (!svixId || !status || !evt.messageId) {
    return NextResponse.json({ ok: true, ignored: true }) // no id / unhandled event → safe no-op
  }

  // Ordering integrity: a supported delivery event MUST carry a valid provider timestamp. Without
  // one we cannot order it and must not overwrite state — acknowledge (200) without applying. We
  // never substitute local receipt time for provider ordering.
  const createdMs = evt.createdAt ? Date.parse(evt.createdAt) : NaN
  if (!Number.isFinite(createdMs)) {
    console.log('[resend.webhook]', JSON.stringify({ type: evt.type, message_id: evt.messageId, ignored: 'invalid_timestamp' }))
    return NextResponse.json({ ok: true, ignored: 'invalid_timestamp' })
  }

  try {
    const outcome = await applyDeliveryEvent(createAdminClient(), {
      svixId,
      providerMessageId: evt.messageId,
      eventType: evt.type,
      eventCreatedAt: evt.createdAt,
      status,
    })
    // Safe log — type + message id + outcome only. No payload/body/recipient/link/token.
    console.log('[resend.webhook]', JSON.stringify({ type: evt.type, message_id: evt.messageId, outcome }))
    // RETRYABLE outcomes → 500 so Resend re-delivers (svix_id + retryable event result keep it
    // idempotent and recoverable): a store 'error', OR 'not_found' (the message id may not be
    // persisted yet — a redelivery reapplies once the delivery row exists).
    if (outcome === 'error' || outcome === 'not_found') {
      return NextResponse.json({ ok: false, error: outcome }, { status: 500 })
    }
    // applied / ignored / duplicate / invalid → completed; acknowledge.
    return NextResponse.json({ ok: true, outcome })
  } catch (e: any) {
    console.error('[resend.webhook] apply failed:', e?.message)
    return NextResponse.json({ ok: false, error: 'processing error' }, { status: 500 }) // retryable
  }
}
