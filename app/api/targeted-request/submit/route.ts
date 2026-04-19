import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { deductCredits, hasEnoughCredits } from '@/lib/credits'

export async function POST(request: Request) {
  const supabase = createClient()
  const adminClient = createAdminClient()
  
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { role, industry, intent } = await request.json()

    // 1. Check if user has premium credits
    const { data: credits } = await supabase
      .from('meeting_credits')
      .select('free_credits, premium_credits')
      .eq('user_id', user.id)
      .single()

    const currentFree = credits?.free_credits || 0
    const currentPremium = credits?.premium_credits || 0

    // MUST have at least 1 premium credit
    if (currentPremium < 1) {
      return NextResponse.json({
        error: 'Premium credit required',
        message: 'You need at least 1 premium credit to submit a targeted request. Purchase credits to unlock this feature.'
      }, { status: 403 })
    }

    // 2. Check for existing pending request (only one at a time)
    const { data: existingRequest } = await supabase
      .from('targeted_requests')
      .select('id')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .maybeSingle()

    if (existingRequest) {
      return NextResponse.json({
        error: 'Request already pending',
        message: 'You already have an active targeted request. It will be applied to your next batch.'
      }, { status: 409 })
    }

    // 3. Deduct 1 premium credit (MUST use premium, not free)
    const premiumToDeduct = 1
    const newPremium = currentPremium - premiumToDeduct
    
    await adminClient
      .from('meeting_credits')
      .update({
        premium_credits: newPremium,
        balance: currentFree + newPremium
      })
      .eq('user_id', user.id)

    console.log('[Targeted Request] Premium credit deducted:', {
      user: user.id,
      premium_before: currentPremium,
      premium_after: newPremium
    })

    // 4. Create targeted request
    const { data: targetedRequest, error: insertError } = await adminClient
      .from('targeted_requests')
      .insert({
        user_id: user.id,
        role: role || null,
        industry: industry || null,
        intent: intent || null,
        status: 'pending',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      })
      .select()
      .single()

    if (insertError) throw insertError

    return NextResponse.json({
      success: true,
      request: targetedRequest,
      message: 'Targeted request submitted! Your next batch will prioritize matches aligned with your intent.'
    })

  } catch (error: any) {
    console.error('Submit targeted request error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
