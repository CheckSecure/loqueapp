import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  pickLatestPerConversation,
  countUnreadByConversation,
  assembleConversationList,
  type MessageRow,
} from '@/lib/messages/conversationList'

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const adminClient = createAdminClient()

  // 1. Matches the user is part of + blocks (two independent queries in parallel).
  const [matchRes, blockRes] = await Promise.all([
    adminClient
      .from('matches')
      .select('id, user_a_id, user_b_id, status, admin_facilitated, is_opportunity_initiated, opportunity_id')
      .or(`user_a_id.eq.${user.id},user_b_id.eq.${user.id}`),
    adminClient
      .from('blocked_users')
      .select('user_id, blocked_user_id')
      .or(`user_id.eq.${user.id},blocked_user_id.eq.${user.id}`),
  ])

  if (matchRes.error) {
    console.error('[conversations/list] match query error:', matchRes.error)
    return NextResponse.json({ error: 'Failed to fetch matches' }, { status: 500 })
  }

  const blockedIds = new Set<string>()
  for (const row of blockRes.data || []) {
    blockedIds.add(row.user_id === user.id ? row.blocked_user_id : row.user_id)
  }

  const matches = (matchRes.data || []).filter(m => {
    if (m.status === 'removed') return false
    const otherId = m.user_a_id === user.id ? m.user_b_id : m.user_a_id
    return !blockedIds.has(otherId)
  })

  const matchIds = matches.map(m => m.id)
  if (matchIds.length === 0) {
    return NextResponse.json({ conversations: [] })
  }

  // 2. Conversations for those matches (ordered — this order is preserved).
  const { data: conversations, error: convErr } = await adminClient
    .from('conversations')
    .select('id, match_id, first_message_sent_at, last_message_at, message_count, created_at')
    .in('match_id', matchIds)
    .order('last_message_at', { ascending: false, nullsFirst: false })

  if (convErr) {
    console.error('[conversations/list] conv query error:', convErr)
    return NextResponse.json({ error: 'Failed to fetch conversations' }, { status: 500 })
  }

  const matchById = new Map(matches.map(m => [m.id, m]))
  const convList = conversations || []
  const convIds = convList.map(c => c.id)

  if (convIds.length === 0) {
    return NextResponse.json({ conversations: [] })
  }

  // Other-user ids + opportunity ids, de-duplicated for batched lookups.
  const otherIds = Array.from(new Set(convList.map(c => {
    const m = matchById.get(c.match_id)
    return m ? (m.user_a_id === user.id ? m.user_b_id : m.user_a_id) : null
  }).filter(Boolean) as string[]))
  const oppIds = Array.from(new Set(convList.map(c => matchById.get(c.match_id)?.opportunity_id).filter(Boolean) as string[]))

  // 3. Batched enrichment — a FIXED number of queries regardless of how many
  //    conversations exist (previously 3 queries PER conversation → N+1).
  const [profilesRes, unreadRes, lastMessages, oppsRes] = await Promise.all([
    // All other-user profiles in one query.
    adminClient
      .from('profiles')
      .select('id, full_name, title, exact_job_title, role_type, company, avatar_url, subscription_tier, account_status')
      .in('id', otherIds),
    // Only UNREAD message rows (typically few), conversation_id only → counted in JS.
    adminClient
      .from('messages')
      .select('conversation_id')
      .in('conversation_id', convIds)
      .neq('sender_id', user.id)
      .eq('is_system', false)
      .is('read_at', null),
    // Latest message per conversation.
    getLatestMessages(adminClient, convIds),
    oppIds.length > 0
      ? adminClient.from('opportunities').select('id, title').in('id', oppIds)
      : Promise.resolve({ data: [] as { id: string; title: string }[] }),
  ])

  const profileById = new Map((profilesRes.data || []).map((p: any) => [p.id, p]))
  const unreadByConv = countUnreadByConversation(unreadRes.data)
  const lastByConv = lastMessages
  const oppTitleById = new Map<string, string>()
  for (const o of oppsRes.data || []) oppTitleById.set(o.id, o.title)

  const finalList = assembleConversationList({
    conversations: convList,
    matchById,
    userId: user.id,
    profileById,
    lastByConv,
    unreadByConv,
    oppTitleById,
  })

  return NextResponse.json({ conversations: finalList })
}

/**
 * Latest message per conversation in ONE round-trip. Prefers a DISTINCT ON
 * Postgres function (bounded to one row per conversation — migration 013); if
 * that function is not present yet, falls back to a single batched fetch and
 * reduces in JS. Both paths yield the same latest-per-conversation map, so the
 * route is safe to deploy before the migration is applied.
 */
async function getLatestMessages(adminClient: any, convIds: string[]): Promise<Map<string, MessageRow>> {
  const rpc = await adminClient.rpc('latest_messages_for_conversations', { conv_ids: convIds })
  if (!rpc.error && Array.isArray(rpc.data)) {
    return pickLatestPerConversation(rpc.data as MessageRow[])
  }
  const { data } = await adminClient
    .from('messages')
    .select('id, conversation_id, content, sender_id, is_system, created_at')
    .in('conversation_id', convIds)
    .order('created_at', { ascending: false })
  return pickLatestPerConversation((data || []) as MessageRow[])
}
