import { createAdminClient } from '@/lib/supabase/admin'
import { createNotificationSafe } from '@/lib/notifications'
import { getAdminUser } from '@/lib/admin/getAdminUser'
import { createSupportMatch, isSupportConnected } from '@/lib/relationships/supportMatch'

const WELCOME_MESSAGE = `Welcome to Andrel — I'm really glad you're here.

Andrel was built around a simple idea: the best professional opportunities come through trusted relationships, not cold outreach.

Our goal is to thoughtfully introduce accomplished people who can genuinely help one another — whether that's sharing expertise, exploring opportunities, or building meaningful long-term relationships.

As one of our founding members, your feedback will help shape where Andrel goes from here. If you have ideas, questions, or someone specific you'd like to meet, just send me a message here — I'd love to hear from you.

A note on how introductions work: each one waits for your response—choose Express interest or Pass. If you express interest, we keep it private until the other person responds independently, so you may be waiting a little while without hearing anything. Responding to the introductions you have keeps you eligible for future introductions. They remain curated rather than scheduled, so there may not be a new introduction in every batch.

— Daniel`

export interface WelcomeResult {
  created: boolean
  reason?: string
  matchId?: string
  conversationId?: string
}

/**
 * Send the admin welcome introduction to a newly-onboarded user.
 *
 * Idempotent on four layers:
 *   1. profiles.welcome_sent_at (primary gate — if set, bail immediately)
 *   2. existing match between admin and user
 *   3. existing conversation for that match
 *   4. existing non-system message from admin in that conversation
 *
 * Never throws. All errors are logged and returned as `{ created: false, reason }`
 * so the caller can treat this as fire-and-forget.
 */
export async function sendAdminWelcome(newUserId: string): Promise<WelcomeResult> {
  try {
    if (!newUserId) {
      return { created: false, reason: 'missing newUserId' }
    }

    const admin = await getAdminUser()
    if (!admin) {
      return { created: false, reason: 'admin user not resolvable' }
    }
    if (admin.id === newUserId) {
      return { created: false, reason: 'new user is the admin; skipping' }
    }

    const client = createAdminClient()

    // Gate 1: welcome_sent_at flag
    const { data: profile } = await client
      .from('profiles')
      .select('id, welcome_sent_at')
      .eq('id', newUserId)
      .maybeSingle()

    if (!profile) {
      return { created: false, reason: 'profile not found' }
    }
    if (profile.welcome_sent_at) {
      return { created: false, reason: 'welcome already sent (flag set)' }
    }

    // ── Gates 2 & 3: match + conversation, via public.create_support_match ──────────────────────
    // PHASE 3 STAGE 1b. The welcome introduction is one of exactly two SANCTIONED cross-community
    // relationships: the platform account must be able to talk to every member, Professional or
    // Next. That exemption is granted by the SQL function on the strength of profiles.is_admin =
    // TRUE, read FOR SHARE in the same transaction as the write — never by this file asserting it,
    // and never by an email address. getAdminUser() above finds the platform account BY email; the
    // RPC then verifies what it found. If that lookup ever resolved to an ordinary member, the RPC
    // refuses with 'not_platform_account' and no cross-community match is created.
    //
    // IDEMPOTENCY IS UNCHANGED, and is now stronger. The previous code did its own existing-match
    // and existing-conversation lookups and inserted when either was absent — two round trips that
    // could leave a match with no conversation. The RPC returns 'already_matched' with the existing
    // ids for a member who already has the welcome match, which is exactly what gates 2 and 3 did,
    // and creates both rows in one transaction otherwise. Gates 1 (welcome_sent_at) and 4 (an
    // existing admin-authored message) are untouched and still decide whether the MESSAGE is sent.
    const support = await createSupportMatch(client, admin.id, newUserId, 'welcome')

    if (!isSupportConnected(support.outcome) || !support.matchId || !support.conversationId) {
      // FAIL CLOSED. No message, no notification, and welcome_sent_at is deliberately NOT set, so a
      // transient failure retries on the next onboarding touch instead of silently skipping the
      // member's welcome forever.
      console.error('[sendAdminWelcome] support match failed:', support.outcome, support.detail)
      return { created: false, reason: `support match failed: ${support.outcome}` }
    }

    const matchId = support.matchId
    const conversationId = support.conversationId

    // Gate 4: existing admin-authored message in the conversation
    const { data: existingMsg } = await client
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('sender_id', admin.id)
      .eq('is_system', false)
      .limit(1)
      .maybeSingle()

    if (existingMsg) {
      // Someone already sent something as admin — don't duplicate.
      // Still set the flag so we stop re-checking.
      await client
        .from('profiles')
        .update({ welcome_sent_at: new Date().toISOString() })
        .eq('id', newUserId)

      return { created: false, reason: 'welcome message already present', matchId, conversationId }
    }

    // Insert welcome message as a normal admin-sent message
    const nowIso = new Date().toISOString()
    const { error: msgErr } = await client
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: admin.id,
        is_system: false,
        content: WELCOME_MESSAGE,
        created_at: nowIso
      })

    if (msgErr) {
      console.error('[sendAdminWelcome] message insert failed:', msgErr)
      return { created: false, reason: `message insert failed: ${msgErr.message}` }
    }

    // Update conversation metadata (first_message_sent_at, last_message_at, count)
    await client
      .from('conversations')
      .update({
        first_message_sent_at: nowIso,
        last_message_at: nowIso,
        message_count: 1
      })
      .eq('id', conversationId)

    // Mark welcome as sent on profile
    await client
      .from('profiles')
      .update({ welcome_sent_at: nowIso })
      .eq('id', newUserId)

    // Notify the new user so the bell badge fires
    await createNotificationSafe({
      userId: newUserId,
      type: 'message_received',
      data: {
        conversationId,
        fromUserId: admin.id
      }
    })

    console.log('[sendAdminWelcome] success', { newUserId, matchId, conversationId })
    return { created: true, matchId, conversationId }
  } catch (err: any) {
    console.error('[sendAdminWelcome] unexpected error:', err?.message || err)
    return { created: false, reason: `unexpected: ${err?.message || 'unknown'}` }
  }
}
