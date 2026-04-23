/**
 * lib/opportunities/connect.ts
 *
 * Terminal state creation: opportunity responder → active match + conversation.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { generateIcebreakers, generateSystemIntroMessage } from '@/lib/messaging/icebreakers';

const OPPORTUNITY_INTRO_REASON = 'Shared opportunity';

export type ConnectResult =
  | { ok: true; match_id: string; conversation_id: string }
  | { ok: false; code: ConnectFailureCode; message: string };

export type ConnectFailureCode =
  | 'opportunity_not_found'
  | 'opportunity_not_active'
  | 'response_not_found'
  | 'response_not_interested'
  | 'already_connected'
  | 'intro_pending'
  | 'blocked'
  | 'cooldown'
  | 'not_creator'
  | 'internal';

export async function connectOpportunityResponder(args: {
  opportunityId: string;
  creatorId: string;
  responderId: string;
}): Promise<ConnectResult> {
  const { opportunityId, creatorId, responderId } = args;
  const admin = createAdminClient();

  const { data: opp } = await admin
    .from('opportunities')
    .select('id, creator_id, status')
    .eq('id', opportunityId)
    .maybeSingle();

  if (!opp) return { ok: false, code: 'opportunity_not_found', message: 'Opportunity not found.' };
  if (opp.creator_id !== creatorId) {
    return { ok: false, code: 'not_creator', message: 'You do not own this opportunity.' };
  }
  if (!['active', 'dormant'].includes(opp.status)) {
    return { ok: false, code: 'opportunity_not_active', message: 'This opportunity is no longer active.' };
  }

  const { data: response } = await admin
    .from('opportunity_responses')
    .select('id, status')
    .eq('opportunity_id', opportunityId)
    .eq('user_id', responderId)
    .maybeSingle();

  if (!response) {
    return { ok: false, code: 'response_not_found', message: 'No response from that user.' };
  }
  if (response.status !== 'interested') {
    return {
      ok: false,
      code: 'response_not_interested',
      message: 'This response is no longer pending.',
    };
  }

  const { data: blocks } = await admin
    .from('blocked_users')
    .select('user_id, blocked_user_id')
    .or(
      `and(user_id.eq.${creatorId},blocked_user_id.eq.${responderId}),` +
      `and(user_id.eq.${responderId},blocked_user_id.eq.${creatorId})`
    );
  if ((blocks ?? []).length > 0) {
    return { ok: false, code: 'blocked', message: 'Cannot introduce — block exists.' };
  }

  const { data: existingMatches } = await admin
    .from('matches')
    .select('id, status, removed_at')
    .or(
      `and(user_a_id.eq.${creatorId},user_b_id.eq.${responderId}),` +
      `and(user_a_id.eq.${responderId},user_b_id.eq.${creatorId})`
    );

  const activeMatch = (existingMatches ?? []).find(
    (m) => ['active', 'accepted'].includes(m.status) && !m.removed_at
  );
  if (activeMatch) {
    return {
      ok: false,
      code: 'already_connected',
      message: 'You are already connected to this person.',
    };
  }

  const recentRemoved = (existingMatches ?? []).find((m) => {
    if (m.status !== 'removed' || !m.removed_at) return false;
    const daysAgo = (Date.now() - new Date(m.removed_at).getTime()) / 86400_000;
    return daysAgo < 180;
  });
  if (recentRemoved) {
    return {
      ok: false,
      code: 'cooldown',
      message: 'Previously connected — cooldown active.',
    };
  }

  const { data: pendingIntros } = await admin
    .from('intro_requests')
    .select('id, status')
    .or(
      `and(requester_id.eq.${creatorId},target_user_id.eq.${responderId}),` +
      `and(requester_id.eq.${responderId},target_user_id.eq.${creatorId})`
    )
    .in('status', ['admin_pending', 'pending', 'approved']);

  if ((pendingIntros ?? []).length > 0) {
    return { ok: false, code: 'intro_pending', message: 'An intro is already in flight.' };
  }

  const { data: match, error: matchErr } = await admin
    .from('matches')
    .insert({
      user_a_id: creatorId,
      user_b_id: responderId,
      status: 'active',
      matched_at: new Date().toISOString(),
      admin_facilitated: false,
      admin_notes: `opportunity_${opportunityId}`,
      is_opportunity_initiated: true,
      opportunity_id: opportunityId,
    })
    .select('id')
    .single();

  if (matchErr || !match) {
    return { ok: false, code: 'internal', message: matchErr?.message ?? 'Match insert failed.' };
  }

  const { data: conversation, error: convErr } = await admin
    .from('conversations')
    .insert({
      match_id: match.id,
      suggested_prompts: [],
    })
    .select('id')
    .single();

  if (convErr || !conversation) {
    return { ok: false, code: 'internal', message: convErr?.message ?? 'Conversation insert failed.' };
  }

  try {
    const [{ data: creatorProfile }, { data: responderProfile }] = await Promise.all([
      admin.from('profiles').select('*').eq('id', creatorId).single(),
      admin.from('profiles').select('*').eq('id', responderId).single(),
    ]);

    const context = {
      userA: creatorProfile || ({} as any),
      userB: responderProfile || ({} as any),
      reason: OPPORTUNITY_INTRO_REASON,
    };

    const prompts = generateIcebreakers(context);
    if (prompts?.length) {
      await admin
        .from('conversations')
        .update({ suggested_prompts: prompts })
        .eq('id', conversation.id);
    }

    const systemContent = generateSystemIntroMessage(context);
    await admin.from('messages').insert({
      conversation_id: conversation.id,
      sender_id: null,
      is_system: true,
      content: systemContent,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[opportunities/connect] icebreaker/system message failed:', e);
    // Match exists + conversation exists — fall back to a plain system line
    // so the conversation isn't silent.
    await admin.from('messages').insert({
      conversation_id: conversation.id,
      sender_id: null,
      is_system: true,
      content: 'You were introduced based on a shared opportunity.',
    });
  }

  await admin
    .from('opportunity_responses')
    .update({ status: 'introduced' })
    .eq('id', response.id);

  const { createNotificationSafe } = await import('@/lib/notifications');
  const conversationLink = `/dashboard/messages/${conversation.id}`;
  await Promise.all([
    createNotificationSafe({
      userId: creatorId,
      type: 'mutual_match',
      link: conversationLink,
      data: { match_id: match.id, source: 'opportunity', opportunity_id: opportunityId, conversation_id: conversation.id },
    }),
    createNotificationSafe({
      userId: responderId,
      type: 'mutual_match',
      link: conversationLink,
      data: { match_id: match.id, source: 'opportunity', opportunity_id: opportunityId, conversation_id: conversation.id },
    }),
  ]);

  return { ok: true, match_id: match.id, conversation_id: conversation.id };
}
