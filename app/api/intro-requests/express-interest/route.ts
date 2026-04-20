import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { sendMatchCreatedEmail } from '@/lib/email'
import { deductCredits, hasEnoughCredits } from '@/lib/credits'

export async function POST(request: Request) {
  const supabase = createClient()
  
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { introRequestId } = await request.json()

  try {
    // Get the intro request
    const { data: introRequest } = await supabase
      .from('intro_requests')
      .select('*, requester:profiles!requester_id(*), target:profiles!target_user_id(*)')
      .eq('id', introRequestId)
      .single()

    if (!introRequest) throw new Error('Intro request not found')

    // Determine who is expressing interest and who is the other party
    const isRequester = user.id === introRequest.requester_id
    const expresserId = user.id
    const otherUserId = isRequester ? introRequest.target_user_id : introRequest.requester_id
    
    console.log('[Express Interest Debug]', {
      userId: user.id,
      requesterId: introRequest.requester_id,
      targetId: introRequest.target_user_id,
      isRequester,
      expresserId,
      otherUserId
    })

    // Update intro request status to 'approved'
    await supabase
      .from('intro_requests')
      .update({ status: 'approved' })
      .eq('id', introRequestId)

    // Check for mutual interest (reverse intro request)
    const { data: reverseRequest, error: reverseError } = await supabase
      .from('intro_requests')
      .select('*')
      .eq('requester_id', otherUserId)
      .eq('target_user_id', expresserId)
      .in('status', ['pending', 'approved'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    
    console.log('[Reverse Request Debug]', {
      reverseRequest,
      reverseError,
      searchingFor: { requester_id: otherUserId, target_user_id: expresserId }
    })

    // If mutual interest exists, auto-create the match
    if (reverseRequest) {
      console.log('[Auto-Match] Mutual interest detected, creating match...')
      
      const adminClient = createAdminClient()

      // Check if match already exists
      const { data: existingMatch } = await supabase
        .from('matches')
        .select('id')
        .or(`and(user_a_id.eq.${expresserId},user_b_id.eq.${otherUserId}),and(user_a_id.eq.${otherUserId},user_b_id.eq.${expresserId})`)
        .maybeSingle()

      if (existingMatch) {
        return NextResponse.json({ 
          success: true, 
          mutualInterest: true,
          matchAlreadyExists: true 
        })
      }

      // Create the match using admin client to bypass RLS
      const { data: match, error: matchError } = await adminClient
        .from('matches')
        .insert({
          user_a_id: expresserId,
          user_b_id: otherUserId,
          status: 'active',
          admin_facilitated: false,
          created_at: new Date().toISOString()
        })
        .select()
        .single()

      if (matchError) {
        console.error('Match creation error:', matchError)
        throw matchError
      }

      // Create conversation
      await adminClient.from('conversations').insert({
        match_id: match.id
      })

      // Get full profile data
      const { data: expresserProfile } = await supabase
        .from('profiles')
        .select('full_name, email, title, company')
        .eq('id', expresserId)
        .single()

      const { data: otherProfile } = await supabase
        .from('profiles')
        .select('full_name, email, title, company')
        .eq('id', otherUserId)
        .single()

      // Send notifications to both users - ONLY when mutual interest confirmed
      await adminClient.from('notifications').insert([
        {
          user_id: expresserId,
          type: 'new_connection',
          title: 'Your introduction is ready',
          body: `You're now connected with ${otherProfile?.full_name}. Start a conversation.`,
          link: '/dashboard/network',
          created_at: new Date().toISOString()
        },
        {
          user_id: otherUserId,
          type: 'new_connection',
          title: 'Your introduction is ready',
          body: `You're now connected with ${expresserProfile?.full_name}. Start a conversation.`,
          link: '/dashboard/network',
          created_at: new Date().toISOString()
        }
      ])

      // Send emails
      if (expresserProfile?.email) {
        try {
          await sendMatchCreatedEmail(
            expresserProfile.email,
            expresserProfile.full_name || 'there',
            otherProfile?.full_name || 'New Connection',
            otherProfile?.title,
            otherProfile?.company
          )
        } catch (e) {
          console.error('Email error:', e)
        }
      }

      if (otherProfile?.email) {
        try {
          await sendMatchCreatedEmail(
            otherProfile.email,
            otherProfile.full_name || 'there',
            expresserProfile?.full_name || 'New Connection',
            expresserProfile?.title,
            expresserProfile?.company
          )
        } catch (e) {
          console.error('Email error:', e)
        }
      }

      // Check credits BEFORE creating match (charge the original requester)
      const initiatorId = introRequest.created_at < reverseRequest.created_at
        ? introRequest.requester_id
        : reverseRequest.requester_id

      const { data: credits } = await adminClient
        .from('meeting_credits')
        .select('free_credits, premium_credits, balance')
        .eq('user_id', initiatorId)
        .single()

      if (!credits) {
        return NextResponse.json({
          error: 'Credit information not found',
          message: 'Unable to process request. Please contact support.'
        }, { status: 500 })
      }

      const currentFree = credits.free_credits || 0
      const currentPremium = credits.premium_credits || 0
      
      // Express Interest requires FREE credits (no premium fallback)
      if (currentFree < 1) {
        return NextResponse.json({
          error: 'Insufficient free credits',
          message: 'No free credits remaining. Upgrade your plan or wait for your monthly refill to continue connecting.',
          free_credits: currentFree,
          premium_credits: currentPremium
        }, { status: 403 })
      }

      // Deduct 1 free credit
      const newFree = currentFree - 1
      
      const { error: creditError } = await adminClient
        .from('meeting_credits')
        .update({
          free_credits: newFree,
          premium_credits: currentPremium, // Keep premium unchanged
          balance: newFree + currentPremium // Keep legacy field in sync
        })
        .eq('user_id', initiatorId)

      if (creditError) {
        console.error('[Credit Deduction] Failed to deduct credit:', creditError)
        return NextResponse.json({
          error: 'Credit deduction failed',
          message: 'Unable to process request. Please try again.'
        }, { status: 500 })
      }
      
      console.log('[Credit Deduction] Express Interest (free credits only):', {
        user: initiatorId,
        free_before: currentFree,
        free_after: newFree,
        premium_unchanged: currentPremium
      })

      return NextResponse.json({
        success: true,
        mutualInterest: true,
        matchCreated: true,
        matchId: match.id
      })

    }

    // No mutual interest yet - just approved the intro request
    return NextResponse.json({
      success: true,
      mutualInterest: false,
      message: 'Interest expressed successfully'
    })

  } catch (error: any) {
    console.error('Express interest error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
