import { createAdminClient } from '@/lib/supabase/admin'
import { createNotificationSafe } from '@/lib/notifications'
import { getAdminUser } from '@/lib/admin/getAdminUser'
import { buildBidirectionalMatchFilter } from '@/lib/db/filters'

const WELCOME_MESSAGE = `Welcome to Andrel — I'm really glad you're here.

Andrel was built around a simple idea: the best professional opportunities come through trusted relationships, not cold outreach.

Our goal is to thoughtfully introduce accomplished people who can genuinely help one another — whether that's sharing expertise, exploring opportunities, or building meaningful long-term relationships.

As one of our founding members, your feedback will help shape where Andrel goes from here. If you have ideas, questions, or someone specific you'd like to meet, just send me a message here — I'd love to hear from you.

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

    // Gate 2: existing match
    const { data: existingMatch } = await client
      .from('matches')
      .select('id')
      .or(buildBidirectionalMatchFilter(admin.id, newUserId))
      .maybeSingle()

    let matchId = existingMatch?.id as string | undefined

    if (!matchId) {
      const { data: newMatch, error: matchErr } = await client
        .from('matches')
        .insert({
          user_a_id: admin.id,
          user_b_id: newUserId,
          status: 'active',
          admin_facilitated: true,
          created_at: new Date().toISOString()
        })
        .select('id')
        .single()

      if (matchErr || !newMatch) {
        console.error('[sendAdminWelcome] match insert failed:', matchErr)
        return { created: false, reason: `match insert failed: ${matchErr?.message}` }
      }
      matchId = newMatch.id
    }

    // Gate 3: existing conversation
    const { data: existingConv } = await client
      .from('conversations')
      .select('id')
      .eq('match_id', matchId)
      .maybeSingle()

    let conversationId = existingConv?.id as string | undefined

    if (!conversationId) {
      const { data: newConv, error: convErr } = await client
        .from('conversations')
        .insert({ match_id: matchId })
        .select('id')
        .single()

      if (convErr || !newConv) {
        console.error('[sendAdminWelcome] conversation insert failed:', convErr)
        return { created: false, reason: `conversation insert failed: ${convErr?.message}` }
      }
      conversationId = newConv.id
    }

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
