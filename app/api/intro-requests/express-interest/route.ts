import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { createNotificationSafe } from '@/lib/notifications'
import { promoteIfResolved } from '@/lib/introductions/queue'
import { notifyNewVisibleBatch } from '@/lib/notifications/engagement'
import { finalizeMutualMatch } from '@/lib/introductions/finalizeMutualMatch'

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

    // STEP 2: Update intro request status to 'approved'. Check the result — a
    // failed/blocked write must surface an error, never a false success.
    const { error: statusUpdateErr } = await supabase
      .from('intro_requests')
      .update({ status: 'approved', updated_at: new Date().toISOString() })
      .eq('id', introRequestId)

    if (statusUpdateErr) {
      console.error('[Express Interest] status update failed:', statusUpdateErr)
      return NextResponse.json(
        { error: 'Could not record your interest. Please try again.' },
        { status: 500 },
      )
    }

    // Advance the queue: if this was the last unresolved card in the expresser's
    // active batch, complete it and reveal any waiting queued batch. Gated by the
    // whole-batch unresolved check inside promoteIfResolved (it no-ops while any
    // card is still open), and idempotent. Non-fatal — mirror createIntroRequest.
    await promoteIfResolved(adminClient, expresserId)
      .then((promo) => {
        // A newly-revealed queued batch is a new visible batch → announce it.
        if (promo.promoted && promo.newActive) return notifyNewVisibleBatch(expresserId, promo.newActive)
      })
      .catch((e) =>
        console.error('[Express Interest] promoteIfResolved failed (non-fatal):', e))

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

    // If mutual interest exists (per the correct filter above), create ACTIVE match
    // immediately — via the shared finalizer so credit/match/notify/email behavior
    // is identical to the Accept-incoming flow.
    if (reverseRequest) {
      const result = await finalizeMutualMatch({
        supabase,
        adminClient,
        actingUserId: expresserId,
        otherUserId,
        isAdminInitiated: Boolean(introRequest.is_admin_initiated),
      })
      return NextResponse.json(result.body, { status: result.status })
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
