/**
 * Pure assembly helpers for the conversation-list API. Extracted so the batched
 * (no N+1) shaping logic is unit-testable without Supabase. The route fetches
 * profiles, last messages, unread rows, and opportunity titles in a fixed number
 * of batched queries, then these helpers stitch them together — preserving the
 * conversation ordering handed in (last_message_at desc) and unread counts.
 */

export type MessageRow = {
  id: string
  conversation_id: string
  content: string | null
  sender_id: string | null
  is_system: boolean | null
  created_at: string
}

/** Latest message per conversation — order-independent (keeps max created_at). */
export function pickLatestPerConversation(rows: MessageRow[] | null | undefined): Map<string, MessageRow> {
  const map = new Map<string, MessageRow>()
  for (const m of rows ?? []) {
    const cur = map.get(m.conversation_id)
    if (!cur || new Date(m.created_at).getTime() > new Date(cur.created_at).getTime()) {
      map.set(m.conversation_id, m)
    }
  }
  return map
}

/** Unread-message count per conversation from the (already unread-filtered) rows. */
export function countUnreadByConversation(rows: { conversation_id: string }[] | null | undefined): Map<string, number> {
  const map = new Map<string, number>()
  for (const r of rows ?? []) map.set(r.conversation_id, (map.get(r.conversation_id) ?? 0) + 1)
  return map
}

export type MatchRow = {
  id: string
  user_a_id: string
  user_b_id: string
  admin_facilitated?: boolean | null
  is_opportunity_initiated?: boolean | null
  opportunity_id?: string | null
}
export type ConversationRow = {
  id: string
  match_id: string
  first_message_sent_at: string | null
  last_message_at: string | null
  message_count: number | null
  created_at: string
}

/**
 * Stitch conversations + batched lookups into the API response shape, preserving
 * input order. Conversations whose match is missing (e.g. filtered out as blocked)
 * are dropped. No I/O — every argument is already fetched.
 */
export function assembleConversationList(args: {
  conversations: ConversationRow[]
  matchById: Map<string, MatchRow>
  userId: string
  profileById: Map<string, any>
  lastByConv: Map<string, MessageRow>
  unreadByConv: Map<string, number>
  oppTitleById: Map<string, string>
}) {
  const { conversations, matchById, userId, profileById, lastByConv, unreadByConv, oppTitleById } = args
  const out: any[] = []
  for (const conv of conversations) {
    const match = matchById.get(conv.match_id)
    if (!match) continue
    const otherId = match.user_a_id === userId ? match.user_b_id : match.user_a_id
    const last = lastByConv.get(conv.id)
    out.push({
      id: conv.id,
      otherUser: profileById.get(otherId) ?? null,
      lastMessage: last
        ? { id: last.id, content: last.content, sender_id: last.sender_id, is_system: last.is_system, created_at: last.created_at }
        : null,
      unreadCount: unreadByConv.get(conv.id) ?? 0,
      firstMessageSentAt: conv.first_message_sent_at,
      lastMessageAt: conv.last_message_at,
      messageCount: conv.message_count ?? 0,
      createdAt: conv.created_at,
      adminFacilitated: match.admin_facilitated ?? false,
      isOpportunityInitiated: !!match.is_opportunity_initiated,
      opportunityTitle: match.opportunity_id ? (oppTitleById.get(match.opportunity_id) ?? null) : null,
    })
  }
  return out
}
