export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { stripe, CREDIT_PACKS } from '@/lib/stripe'
import { createClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const { priceId, mode } = await req.json()
    if (!priceId) return NextResponse.json({ error: 'Missing priceId' }, { status: 400 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id, full_name')
      .eq('id', user.id)
      .single()

    let customerId = profile?.stripe_customer_id

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email!,
        name: profile?.full_name || undefined,
        metadata: { supabase_user_id: user.id },
      })
      customerId = customer.id
      await supabase.from('profiles').update({ stripe_customer_id: customerId }).eq('id', user.id)
    }

    // For credit-pack purchases (mode=payment), resolve the credit count from the
    // server-side CREDIT_PACKS mapping and attach it to the session metadata.
    // The webhook handler gates credit grants on metadata.type === 'credit_purchase'
    // and metadata.credits — without these, a completed checkout would charge the
    // customer but grant no credits. Resolved server-side (not from client) so the
    // credit count cannot be spoofed.
    const creditPack = mode === 'payment' ? CREDIT_PACKS.find(p => p.priceId === priceId) : null
    const sessionMetadata: Record<string, string> = { supabase_user_id: user.id }
    if (creditPack) {
      sessionMetadata.type = 'credit_purchase'
      sessionMetadata.credits = String(creditPack.credits)
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: mode === 'payment' ? 'payment' : 'subscription',
      success_url: `${process.env.NEXT_PUBLIC_SITE_URL}/dashboard/billing?success=true`,
      cancel_url: `${process.env.NEXT_PUBLIC_SITE_URL}/dashboard/billing?cancelled=true`,
      metadata: sessionMetadata,
    })

    return NextResponse.json({ url: session.url })
  } catch (err: any) {
    console.error('[checkout] error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
