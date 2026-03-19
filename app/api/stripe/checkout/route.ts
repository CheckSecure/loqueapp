import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getUncachableStripeClient } from '@/lib/stripe/stripeClient'

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const { priceId, mode = 'subscription' } = await req.json()
    if (!priceId) return NextResponse.json({ error: 'priceId required' }, { status: 400 })

    const stripe = await getUncachableStripeClient()

    // Get or create Stripe customer from profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id, email, full_name')
      .eq('id', user.id)
      .single()

    let customerId = profile?.stripe_customer_id

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? profile?.email ?? undefined,
        name: profile?.full_name ?? undefined,
        metadata: { supabase_user_id: user.id },
      })
      customerId = customer.id

      await supabase
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', user.id)
    }

    const domain = process.env.REPLIT_DOMAINS?.split(',')[0]
    const baseUrl = `https://${domain}`

    // If it's a credit pack, read the credits from price metadata
    let creditsInPack = '0'
    if (mode === 'payment') {
      const price = await stripe.prices.retrieve(priceId, { expand: ['product'] })
      creditsInPack = (price.product as any)?.metadata?.credits ?? price.metadata?.credits ?? '0'
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: mode as 'subscription' | 'payment',
      success_url: `${baseUrl}/dashboard/billing?success=1`,
      cancel_url: `${baseUrl}/dashboard/billing`,
      metadata: { supabase_user_id: user.id, credits: creditsInPack },
    })

    return NextResponse.json({ url: session.url })
  } catch (err: any) {
    console.error('[stripe/checkout]', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
