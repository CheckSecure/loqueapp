import { NextRequest, NextResponse } from 'next/server'
import { stripe } from '@/lib/stripe'
import { createAdminClient } from '@/lib/supabase/admin'
import Stripe from 'stripe'
import { fulfillCreditPurchase, realFulfillDeps, type SessionLike } from '@/lib/stripe/fulfillCreditPurchase'
import { bindCreditReservation, isUuid, releaseCreditReservation } from '@/lib/stripe/creditReservations'

/**
 * CANONICAL Stripe webhook (https://www.andrel.app/api/stripe/webhook).
 *
 * Credit purchases are fulfilled by the shared, atomic, idempotent `fulfillCreditPurchase` (server-side
 * pack resolution + migration-089 reserved grant RPC). Its idempotency marker (credit_grants) and
 * the balance mutation commit in ONE transaction, so a failed grant stays RETRYABLE — it is never
 * marked processed before the grant is durable. Subscription/invoice events (which are naturally
 * idempotent top-up/downgrade operations) keep the INSERT-first `stripe_events` guard.
 */
export async function POST(req: NextRequest) {
  const body = await req.text()
  const sig = req.headers.get('stripe-signature')!
  // Verify against THIS (canonical www) endpoint's OWN signing secret. Prefer the clearly-named
  // canonical variable; fall back to the legacy name only if the canonical one is unset. This resolves
  // to exactly ONE secret — it never tries "either secret", so verification is never weakened. A retry
  // that was originally delivered to the OLD apex endpoint is signed with the OLD endpoint's secret and
  // will therefore FAIL here (400) — that is expected; Jesse is fulfilled via the controlled recovery,
  // not by trusting the old retry.
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET_CANONICAL || process.env.STRIPE_WEBHOOK_SECRET!

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret)
  } catch (err: any) {
    console.error('[webhook] signature verification failed:', err.message)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const adminClient = createAdminClient()

  // Release capacity when Stripe expires an unpaid credit checkout. Binding first also repairs the
  // narrow crash window where Stripe created the session but the checkout route never persisted its
  // session id. Invalid or conflicting metadata is terminal; transient database failures return 500
  // so Stripe retries the signed event.
  if (event.type === 'checkout.session.expired') {
    const session = event.data.object as unknown as SessionLike
    const reservationId = session.metadata?.credit_reservation_id
    const userId = session.metadata?.supabase_user_id
    if (!reservationId || !userId || !isUuid(reservationId)) {
      return NextResponse.json({ received: true })
    }
    try {
      const expiresAt = new Date((session.expires_at ?? Math.floor(Date.now() / 1000)) * 1000)
      const bind = await bindCreditReservation(adminClient, {
        reservationId, userId, sessionId: session.id, expiresAt,
      })
      if (bind === 'conflict') {
        console.log('[webhook]', JSON.stringify({ event: 'credit_reservation_expired', outcome: 'conflict' }))
        return NextResponse.json({ received: true })
      }
      const released = await releaseCreditReservation(adminClient, {
        reservationId, sessionId: session.id, reason: 'stripe_expired',
      })
      console.log('[webhook]', JSON.stringify({ event: 'credit_reservation_expired', outcome: released }))
      return NextResponse.json({ received: true })
    } catch {
      return NextResponse.json({ error: 'retry' }, { status: 500 })
    }
  }

  // CREDIT PURCHASES: fulfilled atomically + idempotently via credit_grants (NOT the stripe_events
  // marker), so a partial/DB failure returns a retryable 500 with nothing recorded → Stripe retries →
  // grants exactly once. A wrong price/owner/amount/unpaid session is terminal (200, no retry storm).
  if (event.type === 'checkout.session.completed') {
    try {
      const res = await fulfillCreditPurchase(
        realFulfillDeps(adminClient, stripe),
        { eventId: event.id, session: event.data.object as unknown as SessionLike },
      )
      console.log('[webhook]', JSON.stringify({ event: 'credit_fulfillment', outcome: res.outcome }))
      return res.retryable
        ? NextResponse.json({ error: 'retry' }, { status: 500 })
        : NextResponse.json({ received: true })
    } catch {
      return NextResponse.json({ error: 'retry' }, { status: 500 })
    }
  }

  try {
    // Idempotency for the remaining (idempotent) subscription/invoice events: atomic INSERT — only one
    // delivery of a given event ID proceeds; a 23505 means a prior/concurrent delivery already claimed
    // the slot → return 200. These operations are top-up/downgrade upserts (safe to skip on retry).
    const { error: idempotencyError } = await adminClient
      .from('stripe_events')
      .insert({ event_id: event.id })

    if (idempotencyError) {
      if (idempotencyError.code === '23505') {
        console.log(`[webhook] duplicate event ${event.id}, skipping`)
        return NextResponse.json({ received: true })
      }
      // Unknown DB error claiming idempotency slot — return 500 so Stripe retries.
      console.error(`[webhook] idempotency insert failed for ${event.id}:`, idempotencyError.message)
      return NextResponse.json({ error: 'DB error' }, { status: 500 })
    }

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription
        const customerId = sub.customer as string
        const priceId = sub.items.data[0].price.id
        const status = sub.status
        // current_period_end is on the item, not the subscription root, as of
        // Stripe API 2025-08-27. data[0] is safe — Andrel subscriptions are
        // single-line-item only. priceId (two lines above) makes the same
        // assumption; multi-item support would need both paths reviewed.
        const rawEnd = sub.items.data[0].current_period_end
        const periodEnd = rawEnd ? new Date(rawEnd * 1000).toISOString() : null

        // Determine tier from price ID
        let tier = 'free'
        if (priceId === process.env.STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID ||
            priceId === process.env.STRIPE_PROFESSIONAL_ANNUAL_PRICE_ID) {
          tier = 'professional'
        } else if (priceId === process.env.STRIPE_EXECUTIVE_MONTHLY_PRICE_ID ||
                   priceId === process.env.STRIPE_EXECUTIVE_ANNUAL_PRICE_ID) {
          tier = 'executive'
        }

        // Only set active tier if subscription is active
        const activeTier = ['active', 'trialing'].includes(status) ? tier : 'free'

        // SUBSCRIPTION/TIER STATE ONLY. Included (free) credits are NOT touched here: the
        // anniversary-cycle system (migration 053) is the SOLE recurring included-credit refill
        // authority. A tier upgrade/downgrade takes effect at the member's NEXT anniversary, when the
        // worker reads this stored subscription_tier via getEffectiveTier. This removes the former
        // top-up-to-floor mutation that could double-grant or reset included credits mid-cycle.
        // Purchased (premium) credits are never read or written on this path.
        await adminClient.from('profiles').update({
          subscription_tier: activeTier,
          stripe_subscription_id: sub.id,
          subscription_status: status,
          current_period_end: periodEnd,
        }).eq('stripe_customer_id', customerId)

        console.log(`[webhook] updated ${customerId} to tier: ${activeTier} (credits unchanged; anniversary refill authoritative)`)
        break
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription
        const customerId = sub.customer as string

        // SUBSCRIPTION/TIER STATE ONLY — do NOT reset included (free) credits here. Downgrade to free
        // takes effect for included credits at the member's NEXT anniversary refill (the worker reads
        // this tier). Purchased (premium) credits are untouched. No mid-cycle credit mutation.
        await adminClient.from('profiles').update({
          subscription_tier: 'free',
          subscription_status: 'canceled',
          stripe_subscription_id: null,
          current_period_end: null,
        }).eq('stripe_customer_id', customerId)

        console.log(`[webhook] subscription deleted for ${customerId}, downgraded to free (credits unchanged)`)
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        const customerId = invoice.customer as string
        await adminClient.from('profiles').update({
          subscription_status: 'past_due',
        }).eq('stripe_customer_id', customerId)
        console.log(`[webhook] payment failed for ${customerId}`)
        break
      }

      // checkout.session.completed is handled BEFORE this switch (credit fulfillment) — it never
      // reaches here.
    }

  } catch (err: any) {
    console.error('[webhook] handler error:', err.message)
    return NextResponse.json({ error: 'Handler error' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}
