import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isWithinEditWindow } from '@/lib/messaging/editWindow'

/**
 * POST /api/messages/edit   { messageId, content }
 *
 * Lets the ORIGINAL SENDER edit their own, non-system message within 60 minutes
 * of created_at. Server-authoritative: the deadline is checked against the
 * stored created_at, never the client clock; sender ownership is enforced in
 * code AND in the scoped update. Updates only content + edited_at; created_at is
 * preserved. Sends no notification and no email. Never returns a false success.
 */
export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { messageId?: string; content?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const messageId = typeof body.messageId === 'string' ? body.messageId : ''
  const content = typeof body.content === 'string' ? body.content : ''
  if (!messageId) {
    return NextResponse.json({ error: 'messageId is required' }, { status: 400 })
  }
  const trimmed = content.trim()
  if (!trimmed) {
    return NextResponse.json({ error: 'Message cannot be empty.' }, { status: 400 })
  }

  const admin = createAdminClient()

  const { data: message, error: fetchErr } = await admin
    .from('messages')
    .select('id, sender_id, is_system, created_at')
    .eq('id', messageId)
    .maybeSingle()

  if (fetchErr) {
    console.error('[messages/edit] fetch error:', fetchErr)
    return NextResponse.json({ error: 'Could not load the message.' }, { status: 500 })
  }
  if (!message) {
    return NextResponse.json({ error: 'Message not found.' }, { status: 404 })
  }
  if (message.is_system) {
    return NextResponse.json({ error: 'System messages cannot be edited.' }, { status: 403 })
  }
  if (message.sender_id !== user.id) {
    // Recipients and admins are not the sender → cannot edit via this endpoint.
    return NextResponse.json({ error: 'You can only edit your own messages.' }, { status: 403 })
  }
  if (!isWithinEditWindow(message.created_at)) {
    return NextResponse.json(
      { error: 'The 1-hour edit window for this message has passed.' },
      { status: 403 },
    )
  }

  // Guarded update: scope by id + sender + non-system so it can never touch
  // another message; .select() lets us confirm exactly one row changed.
  const nowIso = new Date().toISOString()
  const { data: updated, error: updateErr } = await admin
    .from('messages')
    .update({ content: trimmed, edited_at: nowIso })
    .eq('id', messageId)
    .eq('sender_id', user.id)
    .eq('is_system', false)
    .select('id, content, edited_at, created_at')

  if (updateErr) {
    console.error('[messages/edit] update error:', updateErr)
    return NextResponse.json({ error: 'Could not save your edit. Please try again.' }, { status: 500 })
  }
  if (!updated || updated.length !== 1) {
    // 0 rows → nothing was updated; never report success.
    console.error('[messages/edit] update affected', updated?.length ?? 0, 'rows for', messageId)
    return NextResponse.json({ error: 'Could not save your edit. Please try again.' }, { status: 409 })
  }

  return NextResponse.json({ success: true, message: updated[0] })
}
