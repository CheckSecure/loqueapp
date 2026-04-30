import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function GET(
  _req: Request,
  { params }: { params: { conversationId: string } }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const adminClient = createAdminClient()

  // 1. Get conversation
  const { data: conversation, error: convErr } = await adminClient
    .from('conversations')
    .select('id, match_id, first_message_sent_at, last_message_at, message_count, suggested_prompts, created_at')
    .eq('id', params.conversationId)
    .maybeSingle()

  if (convErr || !conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  // 2. Verify access via match
  const { data: match } = await adminClient
    .from('matches')
    .select('id, user_a_id, user_b_id, admin_facilitated, is_opportunity_initiated, opportunity_id')
    .eq('id', conversation.match_id)
    .maybeSingle()

  if (!match) {
    return NextResponse.json({ error: 'Match not found' }, { status: 404 })
  }
  if (match.user_a_id !== user.id && match.user_b_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const otherUserId = match.user_a_id === user.id ? match.user_b_id : match.user_a_id

  // Block check — hide conversation if either user has blocked the other
  const { data: blockRow } = await adminClient
    .from('blocked_users')
    .select('id')
    .or(`and(user_id.eq.${user.id},blocked_user_id.eq.${otherUserId}),and(user_id.eq.${otherUserId},blocked_user_id.eq.${user.id})`)
    .limit(1)
    .maybeSingle()

  if (blockRow) {
    return NextResponse.json({ error: 'Conversation unavailable' }, { status: 403 })
  }

  const { data: otherUser } = await adminClient
    .from('profiles')
    .select('id, full_name, title, company, avatar_url, subscription_tier, account_status')
    .eq('id', otherUserId)
    .single()

  // Mark messages from the other user as read on open (excluding system messages)
  await adminClient
    .from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('conversation_id', conversation.id)
    .neq('sender_id', user.id)
    .eq('is_system', false)
    .is('read_at', null)

  // Load opportunity title if this conversation came from an opportunity.
  let opportunityTitle: string | null = null
  if (match.opportunity_id) {
    const { data: opp } = await adminClient
      .from('opportunities')
      .select('title')
      .eq('id', match.opportunity_id)
      .maybeSingle()
    opportunityTitle = opp?.title ?? null
  }

  return NextResponse.json({
    conversation: {
      id: conversation.id,
      otherUser,
      firstMessageSentAt: conversation.first_message_sent_at,
      lastMessageAt: conversation.last_message_at,
      messageCount: conversation.message_count,
      suggestedPrompts: conversation.suggested_prompts,
      createdAt: conversation.created_at,
      adminFacilitated: match.admin_facilitated || false,
      isOpportunityInitiated: !!match.is_opportunity_initiated,
      opportunityTitle
    }
  })
}
