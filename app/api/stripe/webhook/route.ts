import { NextRequest, NextResponse } from 'next/server'
import { stripe } from '@/lib/stripe'
import { createAdminClient } from '@/lib/supabase/admin'
import Stripe from 'stripe'
import { getMonthlyCredits } from '@/lib/tier-override'

export async function POST(req: NextRequest) {
  const body = await req.text()
  const sig = req.headers.get('stripe-signature')!
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret)
  } catch (err: any) {
    console.error('[webhook] signature verification failed:', err.message)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const adminClient = createAdminClient()

  try {
    // Idempotency check: early-exit if this event was already processed
    const { data: existingEvent } = await adminClient
      .from('stripe_events')
      .select('event_id')
      .eq('event_id', event.id)
      .maybeSingle()

    if (existingEvent) {
      console.log(`[webhook] duplicate event ${event.id}, skipping`)
      return NextResponse.json({ received: true })
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
    }

    // Idempotency record: insert only after successful processing.
    // A mid-handler crash leaves this unwritten so Stripe's retry reprocesses
    // cleanly. Upsert logic above is floor-based (idempotent), so a retry
    // produces the same DB state.
    const { error: idempotencyError } = await adminClient
      .from('stripe_events')
      .insert({ event_id: event.id })

    if (idempotencyError) {
      // CRITICAL: event processed but not recorded — next Stripe retry will
      // reprocess. Floor logic makes that safe here; note for credit-pack
      // commit where this must be verified again.
      console.error(`[webhook] CRITICAL: idempotency insert failed for event ${event.id} (type: ${event.type}):`, idempotencyError.message)
    }

  } catch (err: any) {
    console.error('[webhook] handler error:', err.message)
    return NextResponse.json({ error: 'Handler error' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}

