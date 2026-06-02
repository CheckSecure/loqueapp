import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { sendMatchCreatedEmail } from '@/lib/email'
import { createNotificationSafe } from '@/lib/notifications'
import { generateIcebreakers, generateSystemIntroMessage } from '@/lib/messaging/icebreakers'
import { buildBidirectionalMatchFilter } from '@/lib/db/filters'
import { isSameCompany } from '@/lib/matching/same-company'

export async function POST(request: Request) {
  const supabase = createClient()
  
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { introRequestId } = await request.json()

  try {
    const adminClient = createAdminClient()

    // STEP 0: Block if the other user is deactivated
    const { data: introReqCheck } = await adminClient
      .from('intro_requests')
      .select('requester_id, target_user_id')
      .eq('id', introRequestId)
      .maybeSingle()

    if (!introReqCheck) {
      return NextResponse.json({ error: 'Intro request not found' }, { status: 404 })
    }

    const otherUserIdCheck = user.id === introReqCheck.requester_id
      ? introReqCheck.target_user_id
      : introReqCheck.requester_id

    const { data: otherProfileCheck } = await adminClient
      .from('profiles')
      .select('account_status')
      .eq('id', otherUserIdCheck)
      .maybeSingle()

    if (!otherProfileCheck || otherProfileCheck.account_status !== 'active') {
      return NextResponse.json(
        { error: 'This member is no longer active', message: 'This member is no longer active. No credit was used.' },
        { status: 410 }
      )
    }

    // STEP 1: Get the intro request
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

    // STEP 2: Update intro request status to 'approved'
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

    // For admin intros, fire admin_intro_nudge instead of interest_received so the other
    // user gets a contextual nudge pointing to the Introductions page.
    if (introRequest.is_admin_initiated) {
      await createNotificationSafe({
        userId: otherUserId,
        type: 'admin_intro_nudge',
        data: {
          fromUserId: expresserId,
          fromUserName: expresserProfile?.full_name
        }
      })
    } else {
      await createNotificationSafe({
        userId: otherUserId,
        type: 'interest_received',
        data: {
          fromUserId: expresserId,
          fromUserName: expresserProfile?.full_name
        }
      })
    }

    // STEP 3: Check for mutual interest (reverse intro request)
    // For admin-initiated intros, the reverse row must be 'approved' (the other user
    // has clicked Accept), NOT just 'admin_pending' (pending their acceptance).
    // For user-initiated intros, the reverse can be 'pending' or 'approved' per existing flow.
    const reverseStatusFilter = introRequest.is_admin_initiated
      ? ['approved']
      : ['pending', 'approved']

    // For admin intros: other user's row has requester=expresser, target=other (the other admin row).
    // For user-initiated: other user's row has requester=other, target=expresser (the counter-interest row).
    const reverseQuery = introRequest.is_admin_initiated
      ? supabase.from('intro_requests').select('*').eq('requester_id', expresserId).eq('target_user_id', otherUserId)
      : supabase.from('intro_requests').select('*').eq('requester_id', otherUserId).eq('target_user_id', expresserId)

    const { data: reverseRequest } = await reverseQuery
      .neq('id', introRequestId)
      .in('status', reverseStatusFilter)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // If mutual interest exists (per the correct filter above), create ACTIVE match immediately
    if (reverseRequest) {
      // Defense-in-depth: same-company gate (primary gate is createIntroRequest; this catches
      // any pairs that entered the intro_requests table before the gate was added)
      const { data: companyPair } = await adminClient
        .from('profiles')
        .select('id, company')
        .in('id', [expresserId, otherUserId])

      const expresserCompany = companyPair?.find(p => p.id === expresserId)
      const otherCompany = companyPair?.find(p => p.id === otherUserId)

      if (isSameCompany(
        { company: expresserCompany?.company },
        { company: otherCompany?.company }
      )) {
        return NextResponse.json({ error: 'Introductions between colleagues at the same company are not available.' }, { status: 409 })
      }

      console.log('[Mutual Interest] Detected, creating active match...')

      // Check if match already exists
      const { data: existingMatch } = await supabase
        .from('matches')
        .select('id, status')
        .or(buildBidirectionalMatchFilter(expresserId, otherUserId))
        .maybeSingle()

      if (existingMatch) {
        return NextResponse.json({
          success: true,
          mutualInterest: true,
          matchAlreadyExists: true,
          matchStatus: existingMatch.status
        })
      }

      // Charge both users + create match + create conversation atomically via the
      // RPC. Postgres transaction handles rollback if either credit deduct fails
      // or the matches unique index fires on a TOCTOU race.
      const { data: rpcRows, error: rpcError } = await adminClient.rpc(
        'consume_credits_and_create_match',
        {
          p_user_a: expresserId,
          p_user_b: otherUserId,
          p_admin_facilitated: Boolean(introRequest.is_admin_initiated),
        }
      )

      if (rpcError) {
        console.error('[Mutual Interest] RPC error:', rpcError)
        return NextResponse.json({ error: 'Could not create match' }, { status: 500 })
      }

      const rpcResult = rpcRows?.[0]
      if (!rpcResult) {
        console.error('[Mutual Interest] RPC returned no row')
        return NextResponse.json({ error: 'Could not create match' }, { status: 500 })
      }

      if (rpcResult.error_code === 'insufficient_credits_a') {
        return NextResponse.json({
          error: 'Insufficient credits',
          message: 'You need 1 free credit to connect.',
        }, { status: 403 })
      }

      if (rpcResult.error_code === 'insufficient_credits_b') {
        return NextResponse.json({
          error: 'Connection unavailable',
          message: "Connection can't complete right now. We'll let you know when it can.",
        }, { status: 403 })
      }

      if (rpcResult.error_code === 'duplicate_match') {
        // Defense-in-depth backstop for the same TOCTOU race the application-level
        // dedupe above catches. Treat as success — no double-charge, no dup row.
        return NextResponse.json({
          success: true,
          mutualInterest: true,
          matchAlreadyExists: true,
        })
      }

      const matchId = rpcResult.match_id as string
      const conversationId = rpcResult.conversation_id as string

      console.log('[Match Created via RPC] Both users charged 1 credit:', {
        matchId,
        userA: expresserId,
        userB: otherUserId,
      })

      // Post-RPC: low/no-credits notification for the expresser based on their new
      // balance. Notifying the other user about their own balance is intentionally
      // deferred — they'll see it in their own session and via the monthly cron.
      const { data: postCredits } = await adminClient
        .from('meeting_credits')
        .select('free_credits')
        .eq('user_id', expresserId)
        .maybeSingle()
      const remainingFree = postCredits?.free_credits ?? 0
      if (remainingFree === 0) {
        await createNotificationSafe({
          userId: expresserId,
          type: 'no_credits',
          data: { creditsRemaining: 0 },
        })
      } else if (remainingFree === 1) {
        await createNotificationSafe({
          userId: expresserId,
          type: 'low_credits',
          data: { creditsRemaining: 1 },
        })
      }

      if (conversationId) {
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
          .eq('id', conversationId)

        // Insert system intro message
        const systemMessage = generateSystemIntroMessage({
          userA: expresserProfileFull || {} as any,
          userB: otherProfileFull || {} as any,
          reason: 'Mutual professional interest'
        })

        await adminClient.from('messages').insert({
          conversation_id: conversationId,
          sender_id: null,
          is_system: true,
          content: systemMessage,
          created_at: new Date().toISOString()
        })
      }

      // Get full profile data (for emails)
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

      // Send mutual_match notifications via createNotificationSafe
      // so routing goes to /dashboard/messages/{conversationId}
      await createNotificationSafe({
        userId: expresserId,
        type: 'mutual_match',
        data: {
          conversationId: conversationId,
          matchId: matchId,
          otherUserId: otherUserId,
          otherUserName: otherProfile?.full_name
        }
      })

      await createNotificationSafe({
        userId: otherUserId,
        type: 'mutual_match',
        data: {
          conversationId: conversationId,
          matchId: matchId,
          otherUserId: expresserId,
          otherUserName: expresserProfile?.full_name
        }
      })

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
        matchId: matchId,
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
