import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import Stripe from 'stripe'
import { createAdminClient } from '@/lib/supabase/admin'
import { getEffectiveTier, getMonthlyCredits, getCreditCap } from '@/lib/tier-override'

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
    
    // Determine new tier from price ID (handle both monthly and annual)
    const priceId = subscription.items.data[0]?.price.id
    let stripeTier = 'free'
    
    // Professional: monthly or annual
    const professionalPrices = [
      'price_1TNHfVDuNRcLQVf15Hv4HYHC', // Monthly
      'price_1TNHpWDuNRcLQVf14cO5b0Ja'  // Annual
    ]
    
    // Executive: monthly or annual
    const executivePrices = [
      'price_1TNHgDDuNRcLQVf1mx9Higwc', // Monthly
      'price_1TNHqADuNRcLQVf1XZCdUi3F'  // Annual
    ]
    
    if (professionalPrices.includes(priceId)) {
      stripeTier = 'professional'
    } else if (executivePrices.includes(priceId)) {
      stripeTier = 'executive'
    }
    
    // Use effective tier (respects founding member override)
    const effectiveTier = getEffectiveTier({ ...profile, subscription_tier: stripeTier })
    const newFloor = getMonthlyCredits(effectiveTier)
    
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
    
    console.log(`[Stripe Webhook] User ${profile.id} upgraded to ${stripeTier} (effective: ${effectiveTier}). Credits: ${currentBalance} → ${newBalance}`)
    
    // Update subscription tier (store Stripe tier, not effective tier)
    await adminClient
      .from('profiles')
      .update({
        subscription_tier: stripeTier,
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
        const effectiveTier = getEffectiveTier(profile)
        const cap = getCreditCap(effectiveTier)
        
        const { data: currentCredits } = await adminClient
          .from('meeting_credits')
          .select('balance, lifetime_earned')
          .eq('user_id', profile.id)
          .single()
        
        const currentBalance = currentCredits?.balance || 0
        
        // Grant full purchase first, then clamp to cap
        const afterPurchase = currentBalance + creditsPurchased
        const newBalance = Math.min(afterPurchase, cap)
        const actualAdded = creditsPurchased // Full purchase amount for lifetime_earned
        const clamped = afterPurchase > cap
        
        await adminClient
          .from('meeting_credits')
          .upsert({
            user_id: profile.id,
            balance: newBalance,
            lifetime_earned: (currentCredits?.lifetime_earned || 0) + actualAdded
          })
        
        if (clamped) {
          console.log(`[Credit Purchase] User ${profile.id} purchased ${creditsPurchased}, balance clamped from ${afterPurchase} to ${cap} (tier limit)`)
        } else {
          console.log(`[Credit Purchase] User ${profile.id} purchased ${creditsPurchased}, new balance: ${newBalance}`)
        }
      }
    }
  }

  return NextResponse.json({ received: true })
}
