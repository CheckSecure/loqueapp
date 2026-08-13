import { NextRequest, NextResponse } from 'next/server'
import { stripe } from '@/lib/stripe'
import { createAdminClient } from '@/lib/supabase/admin'
import Stripe from 'stripe'
import { getMonthlyCredits } from '@/lib/tier-override'
import { fulfillCreditPurchase, realFulfillDeps, type SessionLike } from '@/lib/stripe/fulfillCreditPurchase'

/**
 * CANONICAL Stripe webhook (https://www.andrel.app/api/stripe/webhook).
 *
 * Credit purchases are fulfilled by the shared, atomic, idempotent `fulfillCreditPurchase` (server-side
 * pack resolution + migration-052 grant_credit_pack RPC). Its idempotency marker (credit_grants) and
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

        const { data: profile } = await adminClient
          .from('profiles')
          .select('id, subscription_tier')
          .eq('stripe_customer_id', customerId)
          .maybeSingle()

        if (profile) {
          await adminClient.from('profiles').update({
            subscription_tier: activeTier,
            stripe_subscription_id: sub.id,
            subscription_status: status,
            current_period_end: periodEnd,
          }).eq('stripe_customer_id', customerId)

          const newFloor = getMonthlyCredits(activeTier)

          const { data: currentCredits } = await adminClient
            .from('meeting_credits')
            .select('free_credits, premium_credits')
            .eq('user_id', profile.id)
            .maybeSingle()

          const currentFree = currentCredits?.free_credits ?? 0
          const currentPremium = currentCredits?.premium_credits ?? 0
          // TOP-UP-ONLY renewal model (intentional): credits only increase to the
          // tier floor on subscription creation, upgrade, or renewal. Unused credits
          // above the floor carry forward indefinitely. There is no monthly hard-reset.
          // invoice.payment_succeeded is intentionally NOT handled — subscription
          // renewal fires customer.subscription.updated (current_period_end advances)
          // which lands here and applies the same top-up logic.
          const newFree = Math.max(currentFree, newFloor)

          await adminClient.from('meeting_credits')
            .upsert({
              user_id: profile.id,
              free_credits: newFree,
              premium_credits: currentPremium,
              balance: newFree + currentPremium,
            }, { onConflict: 'user_id' })

          console.log(`[webhook] updated ${customerId} to tier: ${activeTier}`)
        }
        break
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription
        const customerId = sub.customer as string

        await adminClient.from('profiles').update({
          subscription_tier: 'free',
          subscription_status: 'canceled',
          stripe_subscription_id: null,
          current_period_end: null,
        }).eq('stripe_customer_id', customerId)

        // Reset credits to free tier
        const { data: profile } = await adminClient
          .from('profiles')
          .select('id')
          .eq('stripe_customer_id', customerId)
          .maybeSingle()

        if (profile) {
          const { data: currentCredits } = await adminClient
            .from('meeting_credits')
            .select('premium_credits')
            .eq('user_id', profile.id)
            .maybeSingle()

          const currentPremium = currentCredits?.premium_credits ?? 0

          await adminClient.from('meeting_credits')
            .upsert({
              user_id: profile.id,
              free_credits: 3,
              premium_credits: currentPremium,
              balance: 3 + currentPremium,
            }, { onConflict: 'user_id' })
        }

        console.log(`[webhook] subscription deleted for ${customerId}, downgraded to free`)
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

