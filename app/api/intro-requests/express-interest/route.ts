import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { sendMatchCreatedEmail } from '@/lib/email'
import { createNotificationSafe } from '@/lib/notifications'
import { generateIcebreakers, generateSystemIntroMessage } from '@/lib/messaging/icebreakers'

export async function POST(request: Request) {
  const supabase = createClient()
  
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { introRequestId } = await request.json()

  try {
    // STEP 1: Validate and deduct credit FIRST (before any DB writes)
    const adminClient = createAdminClient()
    
    const { data: credits } = await adminClient
      .from('meeting_credits')
      .select('free_credits, premium_credits, balance')
      .eq('user_id', user.id)
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

    // Deduct 1 free credit from the person clicking Express Interest
    const newFree = currentFree - 1
    
    const { error: creditError } = await adminClient
      .from('meeting_credits')
      .update({
        free_credits: newFree,
        premium_credits: currentPremium,
        balance: newFree + currentPremium
      })
      .eq('user_id', user.id)

    if (creditError) {
      console.error('[Credit Deduction] Failed to deduct credit:', creditError)
      return NextResponse.json({
        error: 'Credit deduction failed',
        message: 'Unable to process request. Please try again.'
      }, { status: 500 })
    }
    
    console.log('[Express Interest] Credit deducted:', {
      user: user.id,
      free_before: currentFree,
      free_after: newFree
    })

    // Send credit notifications if running low
    if (newFree === 0) {
      await createNotificationSafe({
        userId: user.id,
        type: 'no_credits',
        data: {
          creditsRemaining: 0
        }
      })
    } else if (newFree === 1) {
      await createNotificationSafe({
        userId: user.id,
        type: 'low_credits',
        data: {
          creditsRemaining: 1
        }
      })
    }

    // STEP 2: Get the intro request
    const { data: introRequest } = await supabase
      .from('intro_requests')
      .select('*, requester:profiles!requester_id(*), target:profiles!target_user_id(*)')
      .eq('id', introRequestId)
      .single()

    if (!introRequest) throw new Error('Intro request not found')

    // Determine who is expressing interest
    const isRequester = user.id === introRequest.requester_id
    const expresserId = user.id
    const otherUserId = isRequester ? introRequest.target_user_id : introRequest.requester_id

    // STEP 3: Update intro request status to 'approved'
    await supabase
      .from('intro_requests')
      .update({ status: 'approved' })
      .eq('id', introRequestId)

    // Notify the other user that someone expressed interest
    const { data: expresserProfile } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('id', expresserId)
      .single()

    await createNotificationSafe({
      userId: otherUserId,
      type: 'interest_received',
      data: {
        fromUserId: expresserId,
        fromUserName: expresserProfile?.full_name
      }
    })

    // STEP 4: Check for mutual interest (reverse intro request)
    const { data: reverseRequest } = await supabase
      .from('intro_requests')
      .select('*')
      .eq('requester_id', otherUserId)
      .eq('target_user_id', expresserId)
      .in('status', ['pending', 'approved'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // If mutual interest exists, create ACTIVE match immediately
    if (reverseRequest) {
      console.log('[Mutual Interest] Detected, creating active match...')

      // Check if match already exists
      const { data: existingMatch } = await supabase
        .from('matches')
        .select('id, status')
        .or(`and(user_a_id.eq.${expresserId},user_b_id.eq.${otherUserId}),and(user_a_id.eq.${otherUserId},user_b_id.eq.${expresserId})`)
        .maybeSingle()

      if (existingMatch) {
        return NextResponse.json({
          success: true,
          mutualInterest: true,
          matchAlreadyExists: true,
          matchStatus: existingMatch.status
        })
      }

      // Create ACTIVE match (both users already paid at Express Interest)
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
        console.error('[Match Creation] Error:', matchError)
        throw matchError
      }

      console.log('[Match Created] Active match, both users already paid:', {
        matchId: match.id,
        userA: expresserId,
        userB: otherUserId
      })

      // Create conversation immediately
      const { data: conversation } = await adminClient
        .from('conversations')
        .insert({
          match_id: match.id
        })
        .select()
        .single()

      if (conversation) {
        // Fetch full profiles for icebreaker generation
        const { data: expresserProfileFull } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', expresserId)
          .single()

        const { data: otherProfileFull } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', otherUserId)
          .single()

        // Generate icebreakers based on both users' profiles
        const icebreakers = generateIcebreakers({
          userA: expresserProfileFull || {} as any,
          userB: otherProfileFull || {} as any
        })

        // Update conversation with suggested prompts
        await adminClient
          .from('conversations')
          .update({
            suggested_prompts: icebreakers
          })
          .eq('id', conversation.id)

        // Insert system intro message
        const systemMessage = generateSystemIntroMessage({
          userA: expresserProfile,
          userB: otherProfile,
          reason: 'Mutual professional interest'
        })

        await adminClient.from('messages').insert({
          conversation_id: conversation.id,
          sender_id: null,
          is_system: true,
          content: systemMessage,
          created_at: new Date().toISOString()
        })
      }

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

      // Send notifications to both users
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

      // Send emails (async, don't wait)
      if (expresserProfile?.email && otherProfile) {
        sendMatchCreatedEmail(
          expresserProfile.email,
          expresserProfile.full_name || 'User',
          otherProfile.full_name || 'Your connection',
          otherProfile.title,
          otherProfile.company
        ).catch(e => console.error('Email error:', e))
      }

      if (otherProfile?.email && expresserProfile) {
        sendMatchCreatedEmail(
          otherProfile.email,
          otherProfile.full_name || 'User',
          expresserProfile.full_name || 'Your connection',
          expresserProfile.title,
          expresserProfile.company
        ).catch(e => console.error('Email error:', e))
      }

      return NextResponse.json({
        success: true,
        mutualInterest: true,
        matchCreated: true,
        matchId: match.id,
        matchStatus: 'active'
      })
    }

    // No mutual interest yet - just approved the intro request
    return NextResponse.json({
      success: true,
      mutualInterest: false,
      message: 'Interest expressed successfully'
    })

  } catch (error: any) {
    console.error('[Express Interest] Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
