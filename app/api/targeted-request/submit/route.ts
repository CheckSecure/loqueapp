import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

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

    // 2. Check for existing pending request (exclude expired)
    const { data: existingRequest } = await supabase
      .from('targeted_requests')
      .select('id, expires_at')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())  // ✅ FIX: Exclude expired
      .maybeSingle()

    if (existingRequest) {
      return NextResponse.json({
        error: 'Request already pending',
        message: 'You already have an active targeted request. It will be applied to your next batch.'
      }, { status: 409 })
    }

    // 3. CREATE REQUEST FIRST (before deducting credit)
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

    // Handle duplicate pending request (race condition caught by DB constraint)
    if (insertError) {
      if (insertError.code === '23505') {  // Unique constraint violation
        console.log('[Targeted Request] Duplicate pending request blocked (race condition)', {
          user: user.id,
          error_code: insertError.code
        })
        
        // No refund needed - credit wasn't deducted yet
        return NextResponse.json({
          error: 'Request already pending',
          message: 'You already have an active targeted request. It will be applied to your next batch.'
        }, { status: 409 })
      }
      
      // Other insert errors
      console.error('[Targeted Request] Request creation failed:', insertError)
      throw insertError
    }

    console.log('[Targeted Request] Request created:', {
      request_id: targetedRequest.id,
      user_id: user.id,
      role: targetedRequest.role,
      industry: targetedRequest.industry,
      intent: targetedRequest.intent,
      expires_at: targetedRequest.expires_at
    })

    // 4. THEN deduct premium credit (only after successful insert).
    //
    // This is a LEGITIMATE canonical debit: it already recomputes balance from free + premium, so
    // the invariant holds, and the `currentPremium < 1` gate above keeps it non-negative. What it
    // lacked was an attributable event — a credit moved with nothing recording why. The premium
    // guard is also moved into the WHERE clause so two concurrent submissions cannot both read 1
    // and both write 0.
    const newPremium = currentPremium - 1
    const { data: creditRows, error: creditError } = await adminClient
      .from('meeting_credits')
      .update({
        premium_credits: newPremium,
        balance: currentFree + newPremium
      })
      .eq('user_id', user.id)
      .gte('premium_credits', 1)     // lost race -> zero rows, never a negative balance
      .select('user_id')

    if (!creditError && (creditRows ?? []).length === 0) {
      console.error('[Targeted Request] credit deduction lost a race; rolling back')
      await adminClient.from('targeted_requests').delete().eq('id', targetedRequest.id)
      return NextResponse.json({
        error: 'Premium credit required',
        message: 'Your premium credit was used elsewhere. Nothing was charged.'
      }, { status: 409 })
    }

    if (!creditError) {
      await adminClient.from('credit_transactions').insert({
        user_id: user.id,
        amount: -1,
        type: 'deduction',
        note: 'Targeted request submitted',
        event_key: `targeted_request:${targetedRequest.id}`,
        source_kind: 'targeted_request_debit',
        source_id: targetedRequest.id,
      })
    }

    if (creditError) {
      console.error('[Targeted Request] Credit deduction failed, rolling back:', creditError)
      
      // ROLLBACK: Delete the request we just created
      await adminClient
        .from('targeted_requests')
        .delete()
        .eq('id', targetedRequest.id)
      
      console.log('[Targeted Request] Request deleted due to credit deduction failure:', targetedRequest.id)
      
      throw new Error(`Failed to deduct credit: ${creditError.message}`)
    }

    console.log('[Targeted Request] Premium credit deducted:', {
      user: user.id,
      premium_before: currentPremium,
      premium_after: newPremium,
      request_id: targetedRequest.id
    })

    return NextResponse.json({
      success: true,
      request: targetedRequest,
      message: 'Targeted request submitted! Your next batch will prioritize matches aligned with your intent.'
    })

  } catch (error: any) {
    console.error('[Targeted Request] Submit error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
