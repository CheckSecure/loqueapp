import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * POST /api/messages/read
 *
 * Marks all inbound, unread, non-system messages in a conversation as read
 * for the currently authenticated user.
 *
 * Body: { conversationId: string }
 * Returns: { success: true, markedCount: number }
 *
 * Auth + participation: verified before any write. A user may only mark
 * messages read in a conversation whose match they are part of.
 */
export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { conversationId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const conversationId = body?.conversationId
  if (!conversationId || typeof conversationId !== 'string') {
    return NextResponse.json({ error: 'conversationId required' }, { status: 400 })
  }

  const admin = createAdminClient()

  // 1. Look up the conversation and its linked match.
  const { data: conv, error: convErr } = await admin
    .from('conversations')
    .select('id, match_id')
    .eq('id', conversationId)
    .maybeSingle()

  if (convErr) {
    console.error('[messages/read] conv lookup error:', convErr)
    return NextResponse.json({ error: 'Conversation lookup failed' }, { status: 500 })
  }
  if (!conv) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  // 2. Verify the user is a participant of the match behind this conversation.
  const { data: match, error: matchErr } = await admin
    .from('matches')
    .select('id, user_a_id, user_b_id')
    .eq('id', conv.match_id)
    .maybeSingle()

  if (matchErr) {
    console.error('[messages/read] match lookup error:', matchErr)
    return NextResponse.json({ error: 'Match lookup failed' }, { status: 500 })
  }
  if (!match) {
    return NextResponse.json({ error: 'Match not found' }, { status: 404 })
  }

  const isParticipant =
    match.user_a_id === user.id || match.user_b_id === user.id
  if (!isParticipant) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // 3. Mark unread non-system inbound messages as read.
  //    Only messages authored by the OTHER participant (sender_id != user.id)
  //    and not yet read get touched. System messages (is_system=true, and
  //    messages where sender_id IS NULL which would be system-initiated) are
  //    skipped — they don't contribute to the user's unread count.
  const nowIso = new Date().toISOString()
  const { data: updated, error: updateErr } = await admin
    .from('messages')
    .update({ read_at: nowIso })
    .eq('conversation_id', conversationId)
    .neq('sender_id', user.id)
    .eq('is_system', false)
    .is('read_at', null)
    .select('id')

  if (updateErr) {
    console.error('[messages/read] update error:', updateErr)
    return NextResponse.json({ error: 'Failed to mark read' }, { status: 500 })
  }

  const markedCount = updated?.length ?? 0
  return NextResponse.json({ success: true, markedCount })
}
