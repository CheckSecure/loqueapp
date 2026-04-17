import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import Stripe from 'stripe'
import { createAdminClient } from '@/lib/supabase/admin'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-02-25.clover'
})

const TIER_CREDIT_FLOORS: Record<string, number> = {
  free: 3,
  professional: 10,
  executive: 20
}
const TIER_CREDIT_CAPS: Record<string, number> = {
  free: 6,
  professional: 20,
  executive: 40
}

export async function POST(req: Request) {
  const body = await req.text()
  const signature = headers().get('stripe-signature')!
  
  let event: Stripe.Event
  
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }
  
  const adminClient = createAdminClient()
  
  // Handle subscription created or updated (tier upgrade/downgrade)
  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created') {
    const subscription = event.data.object as any
    const customerId = subscription.customer as string
    
    // Get user by stripe customer ID
    const { data: profile } = await adminClient
      .from('profiles')
      .select('id, subscription_tier')
      .eq('stripe_customer_id', customerId)
      .single()
    
    if (!profile) {
      console.error('No profile found for customer:', customerId)
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
    }
    
    // Determine new tier from price ID
    const priceId = subscription.items.data[0]?.price.id
    let newTier = 'free'
    
    if (priceId === process.env.NEXT_PUBLIC_STRIPE_PROFESSIONAL_PRICE_ID) {
      newTier = 'professional'
    } else if (priceId === process.env.NEXT_PUBLIC_STRIPE_EXECUTIVE_PRICE_ID) {
      newTier = 'executive'
    }
    
    const newFloor = TIER_CREDIT_FLOORS[newTier] || 3
    
    // Get current credit balance
    const { data: currentCredits } = await adminClient
      .from('meeting_credits')
      .select('balance, lifetime_earned')
      .eq('user_id', profile.id)
      .single()
    
    const currentBalance = currentCredits?.balance || 0
    
    // Top up to floor if below, keep higher balance if above
    const newBalance = Math.max(currentBalance, newFloor)
    
    // Update credits
    await adminClient
      .from('meeting_credits')
      .upsert({
        user_id: profile.id,
        balance: newBalance,
        lifetime_earned: (currentCredits?.lifetime_earned || 0) + Math.max(0, newFloor - currentBalance)
      })
    
    console.log(`[Stripe Webhook] User ${profile.id} upgraded to ${newTier}. Credits: ${currentBalance} → ${newBalance}`)
    
    // Update subscription tier
    await adminClient
      .from('profiles')
      .update({
        subscription_tier: newTier,
        subscription_status: subscription.status,
        stripe_subscription_id: subscription.id,
        current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null
      })
      .eq('id', profile.id)
  }
  

  // Handle one-time credit purchases
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as any
    
    if (session.mode === 'payment' && session.metadata?.type === 'credit_purchase') {
      const customerId = session.customer as string
      const creditsPurchased = parseInt(session.metadata.credits || '0')
      
      const { data: profile } = await adminClient
        .from('profiles')
        .select('id, subscription_tier')
        .eq('stripe_customer_id', customerId)
        .single()
      
      if (profile && creditsPurchased > 0) {
        const tier = profile.subscription_tier || 'free'
        const cap = TIER_CREDIT_CAPS[tier] || 6
        
        const { data: currentCredits } = await adminClient
          .from('meeting_credits')
          .select('balance, lifetime_earned')
          .eq('user_id', profile.id)
          .single()
        
        const currentBalance = currentCredits?.balance || 0
        const newBalance = Math.min(currentBalance + creditsPurchased, cap)
        const actualAdded = newBalance - currentBalance
        
        if (actualAdded > 0) {
          await adminClient
            .from('meeting_credits')
            .upsert({
              user_id: profile.id,
              balance: newBalance,
              lifetime_earned: (currentCredits?.lifetime_earned || 0) + actualAdded
            })
          
          console.log(`[Credit Purchase] User ${profile.id} purchased ${creditsPurchased}, added ${actualAdded} (capped at ${cap})`)
        } else {
          console.log(`[Credit Purchase] User ${profile.id} at cap (${cap}), cannot add credits`)
        }
      }
    }
  }

  return NextResponse.json({ received: true })
}
