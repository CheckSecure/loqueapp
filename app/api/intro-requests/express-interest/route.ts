import { createClient } from '@/lib/supabase/server'
import { readProfileById } from '@/lib/profiles/serverProfile'
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

    // Authorization: the caller MUST be a participant of this intro request.
    // Reject arbitrary introRequestId probing with the same neutral 404 as a
    // missing row (never leak the participants' identities).
    const isParticipant =
      user.id === introReqCheck.requester_id || user.id === introReqCheck.target_user_id
    if (!isParticipant) {
      return NextResponse.json({ error: 'Intro request not found' }, { status: 404 })
    }

    const otherUserIdCheck = user.id === introReqCheck.requester_id
      ? introReqCheck.target_user_id
      : introReqCheck.requester_id

    // THE DYSON MAPPING. This read used to discard `error`, so ANY failure — permission, timeout,
    // a future RLS change — became "This member is no longer active": a factual claim about another
    // member, made from a query that never answered. The sibling gate in submitIntroRequest failed
    // exactly that way after migration 058 and told members their provably-active targets were
    // deactivated. A read that did not answer is now its own outcome, and it is retryable.
    const targetRead = await readProfileById<{ account_status: string | null }>(
      otherUserIdCheck, 'account_status', 'express-interest-target')

    if (!targetRead.ok && targetRead.reason === 'unavailable') {
      return NextResponse.json(
        { error: 'We could not verify this member right now. Please try again.',
          message: 'We could not verify this member right now. No credit was used.', code: 'TARGET_UNAVAILABLE' },
        { status: 503 }
      )
    }
    if (!targetRead.ok) {
      return NextResponse.json(
        { error: 'This introduction is no longer available.',
          message: 'This introduction is no longer available. No credit was used.', code: 'TARGET_MISSING' },
        { status: 410 }
      )
    }
    if (targetRead.profile.account_status !== 'active') {
      return NextResponse.json(
        { error: 'This member is no longer active',
          message: 'This member is no longer active. No credit was used.', code: 'TARGET_INACTIVE' },
        { status: 410 }
      )
    }

    // STEP 1: Get the intro request. Only the direction/flag fields are used
    // downstream — do NOT join the full requester/target profiles (that exposed
    // both members' private columns for any caller).
    const { data: introRequest } = await supabase
      .from('intro_requests')
      .select('id, requester_id, target_user_id, is_admin_initiated, status, pair_id')
      .eq('id', introRequestId)
      .single()

    if (!introRequest) throw new Error('Intro request not found')

    // Determine who is expressing interest
    const isRequester = user.id === introRequest.requester_id
    const expresserId = user.id
    const otherUserId = isRequester ? introRequest.target_user_id : introRequest.requester_id

    // STEP 2: Record the interest — but only on a card that is still ACTIONABLE.
    //
    // The update used to be keyed on the id alone, so a card the member had already passed, or that
    // had expired, would be silently REOPENED as 'approved' and could go on to finalize a match the
    // member had declined. The status set is therefore part of the WHERE clause, which also makes
    // this safe against a concurrent pass/expire: whichever write lands first wins, and the loser
    // matches zero rows and is told the card is no longer actionable rather than proceeding.
    //
    // 'approved' is included so an idempotent retry (a lost response after a successful write) is a
    // no-op success rather than a false rejection.
    const ACTIONABLE_FOR_INTEREST = ['suggested', 'pending', 'approved']

    if (!ACTIONABLE_FOR_INTEREST.includes(introRequest.status)) {
      return NextResponse.json(
        { error: 'This introduction is no longer available.',
          message: 'This introduction is no longer available. No credit was used.', code: 'CARD_NOT_ACTIONABLE' },
        { status: 409 }
      )
    }

    const { data: updatedRows, error: statusUpdateErr } = await adminClient
      .from('intro_requests')
      .update({ status: 'approved', updated_at: new Date().toISOString() })
      .eq('id', introRequestId)
      .in('status', ACTIONABLE_FOR_INTEREST)
      .select('id')

    if (!statusUpdateErr && (updatedRows ?? []).length === 0) {
      // Lost a race with a pass/expire between the read above and this write.
      return NextResponse.json(
        { error: 'This introduction is no longer available.',
          message: 'This introduction is no longer available. No credit was used.', code: 'CARD_NOT_ACTIONABLE' },
        { status: 409 }
      )
    }

    if (statusUpdateErr) {
      console.error('[Express Interest] status update failed (class):', (statusUpdateErr as any)?.code ?? 'unknown')
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
    // service_role read (058). Only a display name, and only for the notification below; a failed
    // read degrades the copy rather than failing the member's action.
    const expresserRead = await readProfileById<{ full_name: string | null }>(
      expresserId, 'full_name', 'express-interest-name')
    const expresserProfile = expresserRead.ok ? expresserRead.profile : null

    // PRIVACY — reciprocal pairs (pair_id set): one member's interest MUST stay private until the
    // other independently expresses interest. Both already hold the "Introduced by Andrel" card
    // because Andrel recommended the pair, so we send NO one-sided signal here — the other member is
    // notified only on MUTUAL finalization (finalizeMutualMatch → mutual_match). This structurally
    // separates reciprocal pairs from the legacy/admin one-sided flows by pair_id.
    if (!introRequest.pair_id) {
      // For admin intros, fire admin_intro_nudge instead of interest_received so the other
      // user gets a contextual nudge pointing to the Introductions page. (Legacy/admin only.)
      if (introRequest.is_admin_initiated) {
        await createNotificationSafe({
          userId: otherUserId,
          type: 'admin_intro_nudge',
          data: { fromUserId: expresserId, fromUserName: expresserProfile?.full_name ?? undefined },
        })
      } else {
        await createNotificationSafe({
          userId: otherUserId,
          type: 'interest_received',
          data: { fromUserId: expresserId, fromUserName: expresserProfile?.full_name ?? undefined },
        })
      }
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
        // RELEASE A: the graph read gets its own service-role authority. Same client object the
        // write path already uses, passed under a distinct name so its scope is explicit.
        graphClient: adminClient,
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
    // NEVER return the raw exception. It has carried database messages ('permission denied for
    // table profiles'), which leak schema to a member and read as if THEY did something wrong.
    return NextResponse.json(
      { error: 'Something went wrong recording your interest. Please try again.', code: 'UNEXPECTED' },
      { status: 500 })
  }
}
