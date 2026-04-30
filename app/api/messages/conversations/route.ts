import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const adminClient = createAdminClient()

  // 1. Find all matches the user is part of (excluding removed & blocked)
  const { data: rawMatches, error: matchErr } = await adminClient
    .from('matches')
    .select('id, user_a_id, user_b_id, status, admin_facilitated, is_opportunity_initiated, opportunity_id')
    .or(`user_a_id.eq.${user.id},user_b_id.eq.${user.id}`)

  const { data: blockRows } = await adminClient
    .from('blocked_users')
    .select('user_id, blocked_user_id')
    .or(`user_id.eq.${user.id},blocked_user_id.eq.${user.id}`)

  const blockedIds = new Set<string>()
  for (const row of blockRows || []) {
    if (row.user_id === user.id) blockedIds.add(row.blocked_user_id)
    else blockedIds.add(row.user_id)
  }

  const matches = (rawMatches || []).filter(m => {
    if (m.status === 'removed') return false
    const otherId = m.user_a_id === user.id ? m.user_b_id : m.user_a_id
    return !blockedIds.has(otherId)
  })

  if (matchErr) {
    console.error('[conversations/list] match query error:', matchErr)
    return NextResponse.json({ error: 'Failed to fetch matches' }, { status: 500 })
  }

  const matchIds = (matches || []).map(m => m.id)
  if (matchIds.length === 0) {
    return NextResponse.json({ conversations: [] })
  }

  // 2. Find conversations for those matches
  const { data: conversations, error: convErr } = await adminClient
    .from('conversations')
    .select('id, match_id, first_message_sent_at, last_message_at, message_count, created_at')
    .in('match_id', matchIds)
    .order('last_message_at', { ascending: false, nullsFirst: false })

  if (convErr) {
    console.error('[conversations/list] conv query error:', convErr)
    return NextResponse.json({ error: 'Failed to fetch conversations' }, { status: 500 })
  }

  const matchById = new Map((matches || []).map(m => [m.id, m]))

  // 3. Enrich with other-user profile, last message, unread count
  const enriched = await Promise.all(
    (conversations || []).map(async (conv) => {
      const match = matchById.get(conv.match_id)
      if (!match) return null

      const otherUserId = match.user_a_id === user.id ? match.user_b_id : match.user_a_id

      const [profileRes, lastMessageRes, unreadRes] = await Promise.all([
        adminClient
          .from('profiles')
          .select('id, full_name, title, company, avatar_url, subscription_tier, account_status')
          .eq('id', otherUserId)
          .single(),
        adminClient
          .from('messages')
          .select('id, content, sender_id, is_system, created_at')
          .eq('conversation_id', conv.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        adminClient
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('conversation_id', conv.id)
          .neq('sender_id', user.id)
          .eq('is_system', false)
          .is('read_at', null)
      ])

      return {
        __match_id: conv.match_id,
        id: conv.id,
        otherUser: profileRes.data,
        lastMessage: lastMessageRes.data,
        unreadCount: unreadRes.count || 0,
        firstMessageSentAt: conv.first_message_sent_at,
        lastMessageAt: conv.last_message_at,
        messageCount: conv.message_count || 0,
        createdAt: conv.created_at,
        adminFacilitated: match.admin_facilitated || false
      }
    })
  )

  // Load opportunity titles for any conversations that came from opportunities.
  const validEnriched = enriched.filter(Boolean) as any[]
  const oppIds = new Set<string>()
  for (const conv of validEnriched) {
    const match = matchById.get(conv.id === null ? '' : conv.__match_id || '')
  }
  // Simpler: read opportunity_id straight from the match we already have.
  const oppIdsList: string[] = []
  for (const conv of validEnriched) {
    const match = matchById.get((conv as any).__match_id)
    if (match?.opportunity_id) oppIdsList.push(match.opportunity_id)
  }

  const oppTitleById = new Map<string, string>()
  if (oppIdsList.length > 0) {
    const { data: opps } = await adminClient
      .from('opportunities')
      .select('id, title')
      .in('id', oppIdsList)
    for (const o of opps || []) oppTitleById.set(o.id, o.title)
  }

  // Attach opportunity context and strip internal helpers before returning.
  const finalList = validEnriched.map((conv) => {
    const match = matchById.get((conv as any).__match_id)
    const { __match_id, ...rest } = conv as any
    return {
      ...rest,
      isOpportunityInitiated: !!match?.is_opportunity_initiated,
      opportunityTitle: match?.opportunity_id ? (oppTitleById.get(match.opportunity_id) || null) : null,
    }
  })

  return NextResponse.json({ conversations: finalList })
}
