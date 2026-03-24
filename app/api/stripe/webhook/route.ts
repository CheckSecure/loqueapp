import { NextRequest, NextResponse } from 'next/server'
import { stripe } from '@/lib/stripe'
import { createAdminClient } from '@/lib/supabase/admin'
import Stripe from 'stripe'

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
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription
        const customerId = sub.customer as string
        const priceId = sub.items.data[0].price.id
        const status = sub.status
        const periodEnd = new Date(sub.current_period_end * 1000).toISOString()

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
          .select('id, subscription_tier, meeting_credits(balance)')
          .eq('stripe_customer_id', customerId)
          .single()

        if (profile) {
          await adminClient.from('profiles').update({
            subscription_tier: activeTier,
            stripe_subscription_id: sub.id,
            subscription_status: status,
            current_period_end: periodEnd,
          }).eq('stripe_customer_id', customerId)

          // Top up credits if upgrading
          const creditMap: Record<string, number> = { free: 3, professional: 15, executive: 30 }
          const newCredits = creditMap[activeTier] ?? 3
          await adminClient.from('meeting_credits')
            .upsert({ user_id: profile.id, balance: newCredits }, { onConflict: 'user_id' })

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
          .single()

        if (profile) {
          await adminClient.from('meeting_credits')
            .upsert({ user_id: profile.id, balance: 3 }, { onConflict: 'user_id' })
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
  } catch (err: any) {
    console.error('[webhook] handler error:', err.message)
    return NextResponse.json({ error: 'Handler error' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}

export const config = { api: { bodyParser: false } }
