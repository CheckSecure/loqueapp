/**
 * lib/opportunities/connect.ts
 *
 * Terminal state creation: opportunity responder → active match + conversation.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { createGatedMatch } from '@/lib/relationships/gatedMatch';
import { generateIcebreakers, generateSystemIntroMessage } from '@/lib/messaging/icebreakers';
import { getReferralExclusionsForUser } from '@/lib/referrals/exclusions';
import { readProfilesByIds } from '@/lib/profiles/serverProfile';
import {
  connectionDirections,
  counterpartDisplayName,
  CONNECTION_PARTICIPANT_COLUMNS,
  type ConnectionParticipant,
} from '@/lib/introductions/connectionParticipants';

const OPPORTUNITY_INTRO_REASON = 'Shared opportunity';

/**
 * The ONLY profile columns the icebreaker/system-message generator reads: title/company/bio for the
 * prompts, industry/practice_areas for generateSystemIntroMessage's shared-background lines.
 * Exported so a test can assert no sensitive column creeps back into this read.
 */
export const ICEBREAKER_PROFILE_COLUMNS = 'id, title, company, bio, industry, practice_areas';

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
  | 'user_inactive'
  | 'cooldown'
  | 'not_creator'
  /** The two members belong to different Andrel communities (Phase 3). */
  | 'cross_community'
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

  const { data: statusProfiles } = await admin
    .from('profiles')
    .select('id, account_status')
    .in('id', [creatorId, responderId]);

  const creatorStatus = (statusProfiles ?? []).find(p => p.id === creatorId);
  const responderStatus = (statusProfiles ?? []).find(p => p.id === responderId);

  if (!creatorStatus || creatorStatus.account_status !== 'active' ||
      !responderStatus || responderStatus.account_status !== 'active') {
    return { ok: false, code: 'user_inactive', message: 'This member is no longer active.' };
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

  // Defense-in-depth: matching.ts already filters referral pairs before opportunity
  // delivery. This guard catches any case that slips through (e.g. direct admin actions).
  const referralPairs = await getReferralExclusionsForUser(creatorId)
  if (referralPairs.has(responderId)) {
    return { ok: false, code: 'blocked', message: 'Cannot connect — referral relationship exists.' }
  }

  // ── PHASE 3 STAGE 1b: match + conversation through public.create_gated_match ──────────────────
  // This was two service-role INSERTs — matches, then conversations. Because service_role bypasses
  // RLS, no policy could gate them; the community rule can only bind inside the function that
  // writes. The RPC takes both participant advisory locks, evaluates community_pair_allowed in the
  // same transaction as the INSERT, and writes match + conversation together or neither. That also
  // closes the window where the conversation INSERT failed and returned 'internal' AFTER the match
  // row had already committed — an opportunity connection with no conversation to open.
  //
  // EVERY COLUMN THIS PATH DEPENDS ON IS PASSED THROUGH. matched_at, admin_notes,
  // is_opportunity_initiated and opportunity_id are read by lib/opportunities/caps.ts and
  // rateLimits.ts for delivery caps and re-delivery blocking; suggested_prompts starts as [] and is
  // replaced by the icebreaker UPDATE below exactly as before. This is why the flow does NOT use
  // finalize_mutual_match_atomic, whose delegate writes only three of those columns.
  //
  // Everything above this line — the pending-intro refusal, already_connected, the 180-day
  // cooldown, block and account-active checks, and the referral exclusion — is unchanged and still
  // runs first, so their user-facing codes and messages are exactly what they were.
  const gated = await createGatedMatch(admin, creatorId, responderId, {
    status: 'active',
    matchedAt: new Date().toISOString(),
    adminFacilitated: false,
    adminNotes: `opportunity_${opportunityId}`,
    isOpportunityInitiated: true,
    opportunityId,
    suggestedPrompts: [],
  });

  if (gated.outcome === 'ineligible') {
    return {
      ok: false,
      code: 'cross_community',
      message: 'This member is part of a different Andrel community.',
    };
  }
  if (gated.outcome === 'already_matched') {
    // The active-match check above already returns 'already_connected'; reaching here means another
    // request won the race between that read and this write. Report the same thing it would have,
    // rather than continuing on to introduce two people who are already introduced.
    return {
      ok: false,
      code: 'already_connected',
      message: 'You are already connected to this person.',
    };
  }
  if (gated.outcome !== 'created' || !gated.matchId || !gated.conversationId) {
    // 'invalid' and 'error'. FAIL CLOSED — no system message, no notifications, no emails, no
    // response status change, and no direct-INSERT fallback.
    return { ok: false, code: 'internal', message: 'Match creation failed.' };
  }

  const match = { id: gated.matchId };
  const conversation = { id: gated.conversationId };

  try {
    // LEAST PRIVILEGE. This was `select('*')`, which pulled every profile column — email,
    // stripe_customer_id, subscription_tier, internal scores, verification/moderation flags — into a
    // code path whose entire job is to generate two strings. The narrow list below is exactly what
    // lib/messaging/icebreakers.ts consumes: title/company/bio for the prompts, plus
    // industry/practice_areas for the shared-background lines in generateSystemIntroMessage.
    //
    // WHY THE FALLBACK. Those last two are read through `as any` casts and appear nowhere else in
    // the schema — `practice_areas` in particular has no migration, no other query, and no type. If
    // a named column does not exist, PostgREST fails the whole SELECT, which here would null the
    // profile and silently degrade the icebreakers to the empty-context form. Rather than guess at
    // the live schema, ask for the narrow list and fall back to the previous behaviour verbatim on
    // any error. Strictly never worse than before, and better whenever the columns are all present.
    // (Same deploy-safe shape as the scheduled_timezone and batch version-column fallbacks.)
    const readForIcebreakers = async (id: string) => {
      const narrow = await admin.from('profiles').select(ICEBREAKER_PROFILE_COLUMNS).eq('id', id).single();
      if (!narrow.error) return narrow;
      return admin.from('profiles').select('*').eq('id', id).single();
    };
    const [{ data: creatorProfile }, { data: responderProfile }] = await Promise.all([
      readForIcebreakers(creatorId),
      readForIcebreakers(responderId),
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
      // Keyed on the match for the same reason as the mutual-interest path: `mutual_match` is a
      // SHARED notification type, so without a key this notification and an introduction-flow one
      // suppress each other under the legacy one-per-type-per-24h digest rule. A retry of this same
      // connection stays idempotent. The type, link, copy and data payload are unchanged.
      dedupeKey: match.id,
      data: { match_id: match.id, source: 'opportunity', opportunity_id: opportunityId, conversation_id: conversation.id },
    }),
    createNotificationSafe({
      userId: responderId,
      type: 'mutual_match',
      link: conversationLink,
      dedupeKey: match.id,
      data: { match_id: match.id, source: 'opportunity', opportunity_id: opportunityId, conversation_id: conversation.id },
    }),
  ]);

  // ── CONNECTION EMAIL ────────────────────────────────────────────────────────────────────────
  // An opportunity connection is a real peer connection — same matches row, same conversation, same
  // icebreakers — but it was the only such path that sent no email at all. It now uses the SAME
  // helper as every other connection rather than a parallel template.
  //
  // Recipients are resolved through connectionDirections, so the creator is emailed about the
  // responder and the responder about the creator. Neither is derived from matches.user_a_id /
  // user_b_id, which are interchangeable positions — here creatorId happens to be user_a_id, and
  // depending on that would be exactly the bug this helper exists to prevent.
  //
  // Best-effort and terminal: the match, conversation, system message and notifications above are
  // already committed and are the authoritative state. allSettled inside a try means no email
  // outcome can throw into this function or change its return value.
  try {
    // Lazily imported, exactly as createNotificationSafe is above. lib/email.ts constructs its Resend
    // client at MODULE LOAD and throws when RESEND_API_KEY is unset, so a static import here would
    // make opportunity connections fail at import time in any context without that variable — a
    // dependency this path never had. The email is best-effort; loading its module must be too.
    const { sendMatchCreatedEmail } = await import('@/lib/email');
    const participantRead = await readProfilesByIds<ConnectionParticipant>(
      [creatorId, responderId],
      CONNECTION_PARTICIPANT_COLUMNS,
      'opportunity-connection-participants',
    );
    const directions = connectionDirections(
      creatorId,
      responderId,
      participantRead.ok ? participantRead.profiles : [],
    );
    if (directions.length === 0) {
      console.error('[opportunities/connect] participant profiles unresolved; connection emails skipped');
    }
    const results = await Promise.allSettled(
      directions
        .filter(({ recipient }) => !!recipient.email)
        .map(({ recipient, counterpart }) =>
          sendMatchCreatedEmail(
            recipient.email as string,
            recipient.full_name || 'User',
            counterpartDisplayName(counterpart),
            counterpart.title ?? undefined,
            counterpart.company ?? undefined,
            { conversationId: conversation.id },
          ),
        ),
    );
    for (const r of results) {
      if (r.status === 'rejected') console.error('[opportunities/connect] connection email failed (non-fatal)');
    }
  } catch (e) {
    console.error('[opportunities/connect] connection email step failed (non-fatal)');
  }

  return { ok: true, match_id: match.id, conversation_id: conversation.id };
}
