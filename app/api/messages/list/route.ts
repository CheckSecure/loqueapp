import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchPublicProfilesByIds } from '@/lib/profiles/publicProfile'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const supabase = createClient()
  
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const conversationId = searchParams.get('conversationId')

  if (!conversationId) {
    return NextResponse.json({ 
      error: 'Missing conversationId' 
    }, { status: 400 })
  }

  try {
    // RELEASE A (missed site): the connection graph is read as service_role.
    //
    // Migration 086 revoked every privilege on public.matches from `authenticated`. Two things
    // therefore failed here for every member: the `.select('*, match:matches(*)')` embed, and the
    // conversations read itself, because the convos_select_participant policy contains an inline
    // EXISTS against public.matches and an RLS expression is evaluated as the querying role.
    //
    // The Release A inventory and lib/__tests__/graph-read-hardening.test.ts identify a graph
    // reader by the pattern `.from('matches')`, which a PostgREST embedded resource does not
    // match — which is why this site was never migrated. It is deliberately rewritten as two
    // explicit `.from()` reads rather than an embed on the admin client, so the test can see it.
    //
    // Authority still comes from the verified session in the check below, never from the client
    // used to run the query. Only these two graph reads use graphClient.
    const graphClient = createAdminClient()

    const { data: conversation, error: conversationError } = await graphClient
      .from('conversations')
      .select('id, match_id, suggested_prompts, first_message_sent_at, last_message_at, message_count')
      .eq('id', conversationId)
      .maybeSingle()

    // Destructured and logged: a privilege or query failure must never be reported to the member
    // as "Conversation not found", which is what hid this outage for two days.
    if (conversationError) {
      console.error('[List Messages] conversation read failed:', conversationError)
      return NextResponse.json({ error: 'Failed to load conversation' }, { status: 500 })
    }
    if (!conversation) {
      return NextResponse.json({ 
        error: 'Conversation not found' 
      }, { status: 404 })
    }

    const { data: match, error: matchError } = await graphClient
      .from('matches')
      .select('id, user_a_id, user_b_id')
      .eq('id', conversation.match_id)
      .maybeSingle()

    if (matchError) {
      console.error('[List Messages] match read failed:', matchError)
      return NextResponse.json({ error: 'Failed to load conversation' }, { status: 500 })
    }
    if (!match) {
      return NextResponse.json({ 
        error: 'Match not found' 
      }, { status: 404 })
    }

    // AUTHORIZATION. The two reads above run as service_role and therefore bypass RLS, so this
    // explicit check is the only thing between a member and someone else's thread. user.id and
    // user.email come from getUser() on the cookie-session client — never from the request.
    // (admins have read access to any conversation)
    const ADMIN_EMAIL_BYPASS = process.env.ADMIN_USER_EMAIL || 'bizdev91@gmail.com'
    const isAdmin = user.email === ADMIN_EMAIL_BYPASS
    if (!isAdmin && match.user_a_id !== user.id && match.user_b_id !== user.id) {
      return NextResponse.json({
        error: 'Unauthorized'
      }, { status: 403 })
    }

    // Get messages. A3: the sender profile is no longer embedded via profiles(...)
    // (authenticated SELECT on public.profiles is revoked). Fetch base message rows
    // (including sender_id), then join safe sender fields via the discovery-scoped
    // public_profiles view so the downstream `sender` shape is identical.
    const { data: rawMessages, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })

    if (error) throw error

    const senderProfiles = await fetchPublicProfilesByIds(
      supabase,
      (rawMessages || []).map((m: any) => m.sender_id),
    )
    const messages = (rawMessages || []).map((m: any) => {
      const p = m.sender_id ? senderProfiles.get(m.sender_id) : null
      return {
        ...m,
        // Discoverable sender → the same {id, full_name, title, company} the embed
        // returned; sender present but not discoverable → minimal {id}; no sender
        // (system message, sender_id null) → null, matching the old embed behavior.
        sender: p
          ? { id: p.id, full_name: p.full_name, title: p.title, company: p.company }
          : (m.sender_id ? { id: m.sender_id } : null),
      }
    })

    // Get suggested prompts from conversation
    const suggestedPrompts = conversation.suggested_prompts || []

    // Compute match insights from both profiles
    let matchInsights: { text: string; kind: string }[] = []
    try {
      const otherUserId = match.user_a_id === user.id ? match.user_b_id : match.user_a_id
      // A3: all fields read here are in the public_profiles safe column set, so this
      // discovery-scoped view replaces the (revoked) authenticated SELECT on profiles.
      const { data: bothProfiles } = await supabase
        .from('public_profiles')
        .select('id, full_name, title, company, bio, seniority, role_type, purposes, intro_preferences, interests, expertise, open_to_mentorship')
        .in('id', [user.id, otherUserId])
      if (bothProfiles && bothProfiles.length === 2) {
        const { generateMatchInsights } = await import('@/lib/matching/matchInsights')
        const self = bothProfiles.find(p => p.id === user.id)
        const other = bothProfiles.find(p => p.id === otherUserId)
        if (self && other) matchInsights = generateMatchInsights(self, other)
      }
    } catch (e) {
      console.error('[messages/list] match insights error:', e)
    }

    return NextResponse.json({
      messages: messages || [],
      suggestedPrompts,
      matchInsights,
      conversationMetadata: {
        firstMessageSentAt: conversation.first_message_sent_at,
        lastMessageAt: conversation.last_message_at,
        messageCount: conversation.message_count || 0
      }
    })

  } catch (error: any) {
    console.error('[List Messages] Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
