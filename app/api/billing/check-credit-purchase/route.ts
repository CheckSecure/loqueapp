import { NextResponse } from 'next/server'
import { readProfileById } from '@/lib/profiles/serverProfile'
import { createClient } from '@/lib/supabase/server'
import { getTotalCredits } from '@/lib/credits'
import { getEffectiveTier, getCreditCap } from '@/lib/tier-override'

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  
  const { creditsToPurchase } = await req.json()
  
  // service_role read (migration 058 revoked the authenticated SELECT). A failed read must not be
  // silently treated as "no entitlement".
  const tierRead = await readProfileById<{
    subscription_tier: string | null; is_founding_member: boolean | null; founding_member_expires_at: string | null
  }>(user.id, 'subscription_tier, is_founding_member, founding_member_expires_at', 'credit-purchase-check')
  if (!tierRead.ok && tierRead.reason === 'unavailable') {
    return NextResponse.json({ error: 'Temporarily unavailable. Please try again.' }, { status: 503 })
  }
  const profile = tierRead.ok ? tierRead.profile : null
  
  const { data: credits } = await supabase
    .from('meeting_credits')
    .select('free_credits, premium_credits, balance')
    .eq('user_id', user.id)
    .single()
  
  const effectiveTier = getEffectiveTier(profile || {})
  const currentFree = credits?.free_credits || 0
  const currentPremium = credits?.premium_credits || 0
  const currentTotal = getTotalCredits(currentFree, currentPremium)
  const cap = getCreditCap(effectiveTier)
  
  // Purchased credits go into premium_credits
  // Cap applies to total (free + premium)
  const premiumAfterPurchase = currentPremium + creditsToPurchase
  const totalAfterPurchase = currentFree + premiumAfterPurchase
  
  const usableTotal = Math.min(totalAfterPurchase, cap)
  const willExceedCap = totalAfterPurchase > cap
  const unusableCredits = willExceedCap ? totalAfterPurchase - cap : 0
  
  return NextResponse.json({
    currentFree,
    currentPremium,
    currentTotal,
    creditsToPurchase,
    premiumAfterPurchase,
    totalAfterPurchase,
    cap,
    usableTotal,
    willExceedCap,
    unusableCredits,
    warning: willExceedCap
      ? `Your ${effectiveTier} plan allows a maximum of ${cap} active credits. ${unusableCredits} credit(s) will not be usable until your balance drops.`
      : null
  })
}
