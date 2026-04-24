import { createAdminClient } from '@/lib/supabase/admin'
import { createNotificationSafe } from '@/lib/notifications'
import { getAdminUser } from '@/lib/admin/getAdminUser'
import { buildBidirectionalMatchFilter } from '@/lib/db/filters'

const WELCOME_MESSAGE = `Welcome to Andrel — glad you're here.

Andrel is a curated professional network built around thoughtful introductions, not feeds or browsing.

Here's how to get the most out of it:

1. Complete your profile carefully.
Your title, company, bio, expertise, interests, and preferences help us understand who would be valuable for you to meet.

2. Review your introductions.
When someone is suggested, you can express interest or pass. Andrel uses a simple credit system to keep introductions intentional and high-quality — you'll only use a credit when a connection is actually made.

3. Use Messages to build the relationship.
Once an introduction is active, you can message directly and use the suggested prompts to start the conversation.

4. Check Opportunities.
Opportunities are private, curated signals for hiring or business needs — whether you're looking for a role or offering help on a specific problem. You can opt in from Settings if you're open to relevant opportunities or recruiter outreach.

5. Keep it intentional.
Andrel works best when users respond thoughtfully, accept introductions they genuinely want, and use the platform to build real professional relationships.

If you have questions or want help getting started, just reply here.

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
