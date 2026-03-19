import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getUncachableStripeClient, getStripeSync } from '@/lib/stripe/stripeClient'
import { runMigrations } from 'stripe-replit-sync'

let initialized = false

async function ensureStripeInit() {
  if (initialized) return
  const databaseUrl = process.env.DATABASE_URL!
  await runMigrations({ databaseUrl })
  const sync = await getStripeSync()
  const domain = process.env.REPLIT_DOMAINS?.split(',')[0]
  await sync.findOrCreateManagedWebhook(`https://${domain}/api/stripe/webhook`)
  sync.syncBackfill().catch((e: Error) => console.error('[stripe] backfill error:', e.message))
  initialized = true
}

export async function POST(req: NextRequest) {
  // Ensure stripe schema and webhook are set up
  await ensureStripeInit().catch(e => console.error('[stripe] init error:', e.message))

  const payload = await req.text()
  const signature = req.headers.get('stripe-signature') ?? ''

  try {
    const sync = await getStripeSync()
    await sync.processWebhook(Buffer.from(payload), signature)
  } catch (err: any) {
    console.error('[stripe/webhook] processWebhook error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 400 })
  }

  // Handle business-specific events: update Supabase on subscription changes
  try {
    const stripe = await getUncachableStripeClient()
    const supabase = createClient()

    const event = stripe.webhooks.constructEventUnsafe(payload, signature, '') as any

    if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) {
      const sub = event.data.object
      const customerId = sub.customer as string

      // Find profile by stripe_customer_id
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('stripe_customer_id', customerId)
        .single()

      if (profile) {
        const isActive = sub.status === 'active' || sub.status === 'trialing'
        // Determine tier from price metadata
        let tier = 'free'
        const priceId = sub.items?.data?.[0]?.price?.id as string | undefined
        if (priceId) {
          const price = await stripe.prices.retrieve(priceId, { expand: ['product'] })
          const productName = ((price.product as any)?.name ?? '').toLowerCase()
          if (productName.includes('executive')) tier = 'executive'
          else if (productName.includes('professional') || productName.includes('pro')) tier = 'professional'
        }

        await supabase
          .from('profiles')
          .update({
            subscription_tier: isActive ? tier : 'free',
            stripe_subscription_id: isActive ? sub.id : null,
          })
          .eq('id', profile.id)
      }
    }

    // Handle one-time payment (credit packs): checkout.session.completed
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      if (session.mode === 'payment' && session.payment_status === 'paid') {
        const userId = session.metadata?.supabase_user_id
        const creditsToAdd = parseInt(session.metadata?.credits ?? '0', 10)

        if (userId && creditsToAdd > 0) {
          // Fetch current balance
          const { data: creditRow } = await supabase
            .from('meeting_credits')
            .select('balance')
            .eq('user_id', userId)
            .single()

          const newBalance = (creditRow?.balance ?? 0) + creditsToAdd

          await supabase
            .from('meeting_credits')
            .upsert({ user_id: userId, balance: newBalance }, { onConflict: 'user_id' })

          await supabase.from('credit_transactions').insert({
            user_id: userId,
            amount: creditsToAdd,
            description: `Credit pack purchase (${creditsToAdd} credits)`,
          })
        }
      }
    }
  } catch (err: any) {
    // Log but don't fail — the webhook was already processed above
    console.error('[stripe/webhook] business logic error:', err.message)
  }

  return NextResponse.json({ received: true })
}
