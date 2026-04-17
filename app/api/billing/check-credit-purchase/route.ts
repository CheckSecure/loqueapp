import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const TIER_CREDIT_CAPS: Record<string, number> = {
  free: 6,
  professional: 20,
  executive: 40
}

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  
  const { creditsToPurchase } = await req.json()
  
  const { data: profile } = await supabase
    .from('profiles')
    .select('subscription_tier')
    .eq('id', user.id)
    .single()
  
  const { data: credits } = await supabase
    .from('meeting_credits')
    .select('balance')
    .eq('user_id', user.id)
    .single()
  
  const tier = profile?.subscription_tier || 'free'
  const currentBalance = credits?.balance || 0
  const cap = TIER_CREDIT_CAPS[tier] || 6
  
  const balanceAfterPurchase = currentBalance + creditsToPurchase
  const usableCredits = Math.min(balanceAfterPurchase, cap)
  const willExceedCap = balanceAfterPurchase > cap
  const unusableCredits = willExceedCap ? balanceAfterPurchase - cap : 0
  
  return NextResponse.json({
    currentBalance,
    creditsToPurchase,
    balanceAfterPurchase,
    cap,
    usableCredits,
    willExceedCap,
    unusableCredits,
    warning: willExceedCap 
      ? `Your ${tier} plan allows a maximum of ${cap} active credits. ${unusableCredits} credit(s) will not be usable until your balance drops.`
      : null
  })
}
