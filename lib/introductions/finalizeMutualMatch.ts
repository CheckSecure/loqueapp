// Mutual-match finalization — the shared tail of every "both members expressed
// interest" transition. Extracted verbatim from the express-interest route so the
// two entry points (the Express-interest button and the new Accept-incoming flow)
// charge credits, create the match + conversation, seed icebreakers, notify, and
// email through ONE code path — credit, dedupe, match, and notification behavior
// stay identical by construction.
//
// Precondition: BOTH sides have expressed interest (each side's intro_requests row
// is `approved`). This function does NOT detect reciprocity — the caller guarantees
// it. It creates the match idempotently (existing-match + RPC duplicate backstops).

import { sendMatchCreatedEmail } from '@/lib/email'
import { createNotificationSafe } from '@/lib/notifications'
import { generateIcebreakers, generateSystemIntroMessage } from '@/lib/messaging/icebreakers'
import { buildBidirectionalMatchFilter } from '@/lib/db/filters'
import { isSameCompany } from '@/lib/matching/same-company'
import { bothMembersConsented } from '@/lib/introRequests/classify'

export interface FinalizeResult {
  status: number
  body: Record<string, unknown>
}

/**
 * Retire any outstanding "Someone is waiting on your response" reminders for a
 * now-connected pair. Marks unread `waiting_response` rows read (both directions)
 * so a stale nudge can't keep pointing at an item that is already resolved.
 * Best-effort and idempotent — never throws into the match flow.
 */
export async function retireWaitingResponseForPair(
  adminClient: any,
  userA: string,
  userB: string,
): Promise<void> {
  try {
    const nowIso = new Date().toISOString()
    // Reminder recipient is the "waiter"; the expresser is in data.fromUserId.
    // Retire in both directions so whichever side was reminded is cleared.
    for (const [waiter, expresser] of [[userA, userB], [userB, userA]] as const) {
      await adminClient
        .from('notifications')
        .update({ read_at: nowIso })
        .eq('type', 'waiting_response')
        .eq('user_id', waiter)
        .is('read_at', null)
        .eq('data->>fromUserId', expresser)
    }
  } catch (e: any) {
    console.error('[finalizeMutualMatch] retire waiting_response failed (non-fatal):', e?.message)
  }
}

export async function finalizeMutualMatch(params: {
  supabase: any
  adminClient: any
  actingUserId: string
  otherUserId: string
  isAdminInitiated: boolean
}): Promise<FinalizeResult> {
  const { supabase, adminClient, actingUserId, otherUserId, isAdminInitiated } = params

  // Defense-in-depth: same-company gate (primary gate is createIntroRequest; this
  // catches pairs that entered intro_requests before the gate existed).
  const { data: companyPair } = await adminClient
    .from('profiles')
    .select('id, company')
    .in('id', [actingUserId, otherUserId])

  const actingCompany = companyPair?.find((p: any) => p.id === actingUserId)
  const otherCompany = companyPair?.find((p: any) => p.id === otherUserId)

  if (isSameCompany({ company: actingCompany?.company }, { company: otherCompany?.company })) {
    return {
      status: 409,
      body: { error: 'Introductions between colleagues at the same company are not available.' },
    }
  }

  console.log('[Mutual Interest] Detected, creating active match...')

  // Idempotency: an existing match means we're done — no double-charge, no dup row.
  const { data: existingMatch } = await supabase
    .from('matches')
    .select('id, status')
    .or(buildBidirectionalMatchFilter(actingUserId, otherUserId))
    .maybeSingle()

  if (existingMatch) {
    await retireWaitingResponseForPair(adminClient, actingUserId, otherUserId)
    return {
      status: 200,
      body: {
        success: true,
        mutualInterest: true,
        matchAlreadyExists: true,
        matchStatus: existingMatch.status,
      },
    }
  }

  // CONSENT REVALIDATION (race-safe, defense-in-depth). Re-read BOTH directional rows from the live
  // table immediately before the transactional RPC and require that each member has independently
  // consented — the acting member with an outbound consent row, the counterpart with an outbound
  // interest row. A stale earlier UI/query check cannot authorize a match after consent is withdrawn
  // or a row changes; an admin click, is_admin_initiated, admin_pending, or a displayed
  // recommendation can never satisfy this. Callers must never rely solely on their own pre-check.
  const { data: consentRows } = await adminClient
    .from('intro_requests')
    .select('requester_id, target_user_id, status')
    .or(
      `and(requester_id.eq.${actingUserId},target_user_id.eq.${otherUserId}),` +
      `and(requester_id.eq.${otherUserId},target_user_id.eq.${actingUserId})`,
    )
  if (!bothMembersConsented(consentRows ?? [], actingUserId, otherUserId)) {
    console.warn('[finalizeMutualMatch] consent revalidation failed — not finalizing', { actingUserId, otherUserId })
    return {
      status: 409,
      body: { error: 'Both members must independently express interest before connecting.', mutualInterest: false },
    }
  }

  // Charge both users + create match + conversation atomically via the RPC.
  const { data: rpcRows, error: rpcError } = await adminClient.rpc(
    'consume_credits_and_create_match',
    {
      p_user_a: actingUserId,
      p_user_b: otherUserId,
      p_admin_facilitated: Boolean(isAdminInitiated),
    },
  )

  if (rpcError) {
    console.error('[Mutual Interest] RPC error:', rpcError)
    return { status: 500, body: { error: 'Could not create match' } }
  }

  const rpcResult = rpcRows?.[0]
  if (!rpcResult) {
    console.error('[Mutual Interest] RPC returned no row')
    return { status: 500, body: { error: 'Could not create match' } }
  }

  if (rpcResult.error_code === 'insufficient_credits_a') {
    return {
      status: 403,
      body: { error: 'Insufficient credits', message: 'You need 1 free credit to connect.' },
    }
  }

  if (rpcResult.error_code === 'insufficient_credits_b') {
    return {
      status: 403,
      body: {
        error: 'Connection unavailable',
        message: "Connection can't complete right now. We'll let you know when it can.",
      },
    }
  }

  if (rpcResult.error_code === 'duplicate_match') {
    // Backstop for the same TOCTOU race the existing-match check above catches.
    await retireWaitingResponseForPair(adminClient, actingUserId, otherUserId)
    return { status: 200, body: { success: true, mutualInterest: true, matchAlreadyExists: true } }
  }

  const matchId = rpcResult.match_id as string
  const conversationId = rpcResult.conversation_id as string

  console.log('[Match Created via RPC] Both users charged 1 credit:', {
    matchId,
    userA: actingUserId,
    userB: otherUserId,
  })

  // Reciprocal-pair lifecycle: a formed match is terminal for the pair — mark it 'matched' in the
  // PRIMARY match path (not only later during rotation), so a late pass/rotation never treats it as
  // active. Canonical (user_a_id < user_b_id). Best-effort + tolerant of member_pairs being absent
  // (pre-migration / admin pairs): a failure here must never fail the match.
  try {
    const lo = actingUserId < otherUserId ? actingUserId : otherUserId
    const hi = actingUserId < otherUserId ? otherUserId : actingUserId
    await adminClient.from('member_pairs').update({ status: 'matched' }).eq('user_a_id', lo).eq('user_b_id', hi)
  } catch { /* member_pairs may not exist yet; never block the match */ }

  // Post-RPC low/no-credits nudge for the acting user based on their new balance.
  const { data: postCredits } = await adminClient
    .from('meeting_credits')
    .select('free_credits')
    .eq('user_id', actingUserId)
    .maybeSingle()
  const remainingFree = postCredits?.free_credits ?? 0
  if (remainingFree === 0) {
    await createNotificationSafe({ userId: actingUserId, type: 'no_credits', data: { creditsRemaining: 0 } })
  } else if (remainingFree === 1) {
    await createNotificationSafe({ userId: actingUserId, type: 'low_credits', data: { creditsRemaining: 1 } })
  }

  if (conversationId) {
    const { data: actingProfileFull } = await supabase.from('profiles').select('*').eq('id', actingUserId).single()
    const { data: otherProfileFull } = await supabase.from('profiles').select('*').eq('id', otherUserId).single()

    const icebreakers = generateIcebreakers({
      userA: actingProfileFull || ({} as any),
      userB: otherProfileFull || ({} as any),
    })

    await adminClient.from('conversations').update({ suggested_prompts: icebreakers }).eq('id', conversationId)

    const systemMessage = generateSystemIntroMessage({
      userA: actingProfileFull || ({} as any),
      userB: otherProfileFull || ({} as any),
      reason: 'Mutual professional interest',
    })

    await adminClient.from('messages').insert({
      conversation_id: conversationId,
      sender_id: null,
      is_system: true,
      content: systemMessage,
      created_at: new Date().toISOString(),
    })
  }

  const { data: actingProfile } = await supabase
    .from('profiles')
    .select('full_name, email, title, company')
    .eq('id', actingUserId)
    .single()
  const { data: otherProfile } = await supabase
    .from('profiles')
    .select('full_name, email, title, company')
    .eq('id', otherUserId)
    .single()

  await createNotificationSafe({
    userId: actingUserId,
    type: 'mutual_match',
    data: { conversationId, matchId, otherUserId, otherUserName: otherProfile?.full_name },
  })
  await createNotificationSafe({
    userId: otherUserId,
    type: 'mutual_match',
    data: { conversationId, matchId, otherUserId: actingUserId, otherUserName: actingProfile?.full_name },
  })

  if (actingProfile?.email && otherProfile) {
    sendMatchCreatedEmail(
      actingProfile.email,
      actingProfile.full_name || 'User',
      otherProfile.full_name || 'Your connection',
      otherProfile.title,
      otherProfile.company,
    ).catch((e) => console.error('Email error:', e))
  }
  if (otherProfile?.email && actingProfile) {
    sendMatchCreatedEmail(
      otherProfile.email,
      otherProfile.full_name || 'User',
      actingProfile.full_name || 'Your connection',
      actingProfile.title,
      actingProfile.company,
    ).catch((e) => console.error('Email error:', e))
  }

  // A connection resolves any "waiting on your response" reminders for the pair.
  await retireWaitingResponseForPair(adminClient, actingUserId, otherUserId)

  return {
    status: 200,
    body: { success: true, mutualInterest: true, matchCreated: true, matchId, matchStatus: 'active' },
  }
}
