import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createNotificationSafe } from '@/lib/notifications'
import { shouldEmailNewMessage } from '@/lib/notifications/engagement'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const supabase = createClient()
  const adminClient = createAdminClient()
  
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { conversationId, content } = await request.json()

    if (!conversationId || !content?.trim()) {
      return NextResponse.json({ 
        error: 'Missing required fields' 
      }, { status: 400 })
    }

    // Get conversation and verify user is part of it
    const { data: conversation } = await adminClient
      .from('conversations')
      .select('*, match:matches(*)')
      .eq('id', conversationId)
      .single()

    if (!conversation) {
      return NextResponse.json({ 
        error: 'Conversation not found' 
      }, { status: 404 })
    }

    const match = conversation.match
    if (!match) {
      return NextResponse.json({ 
        error: 'Match not found' 
      }, { status: 404 })
    }

    // Verify user is part of this match
    if (match.user_a_id !== user.id && match.user_b_id !== user.id) {
      return NextResponse.json({ 
        error: 'Unauthorized' 
      }, { status: 403 })
    }

    // Determine recipient
    const recipientId = match.user_a_id === user.id
      ? match.user_b_id
      : match.user_a_id

    // Block sends to deactivated recipients. Also pull the fields the new-message
    // email needs (email, name) so no extra round-trip is added. last_active_at now lives
    // in the private member_presence table (read below, service-role bypasses its RLS).
    const { data: recipientProfile } = await adminClient
      .from('profiles')
      .select('account_status, email, full_name')
      .eq('id', recipientId)
      .single()

    if (recipientProfile?.account_status === 'deactivated') {
      return NextResponse.json(
        { ok: false, code: 'RECIPIENT_INACTIVE', message: 'This member is no longer active. Messages cannot be sent.' },
        { status: 403 }
      )
    }

    // Insert message
    const { data: message, error: messageError } = await adminClient
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: user.id,
        content: content.trim(),
        is_system: false,
        created_at: new Date().toISOString()
      })
      .select()
      .single()

    if (messageError) throw messageError

    // Update conversation metadata
    const now = new Date().toISOString()
    const isFirstMessage = !conversation.first_message_sent_at

    await adminClient
      .from('conversations')
      .update({
        first_message_sent_at: conversation.first_message_sent_at || now,
        last_message_at: now,
        message_count: (conversation.message_count || 0) + 1
      })
      .eq('id', conversationId)

    // Send notification to recipient. dedupeKey = message id → one notification
    // per message (retries are idempotent); link opens this exact conversation.
    const createdNotif = await createNotificationSafe({
      userId: recipientId,
      type: 'message_received',
      data: {
        conversationId,
        fromUserId: user.id,
        messageId: message.id
      },
      link: `/dashboard/messages/${conversationId}`,
      dedupeKey: message.id
    })

    console.log('[Message Sent]:', {
      conversationId,
      senderId: user.id,
      recipientId,
      isFirstMessage
    })

    // New-message email — best-effort, never blocks the send response.
    //  • Only on a NEWLY-created notification (createNotificationSafe returns null
    //    on a duplicate message id) → one email per message, race-safe across workers.
    //  • Throttled by shouldEmailNewMessage: skip if the recipient is currently active
    //    (touched the app within MESSAGE_EMAIL_ACTIVE_WINDOW_MS) OR already has another
    //    UNREAD message nudge for this conversation (they haven't caught up yet).
    //  • Preference-aware: sendNewMessageEmail is gated by email_messages (fail-open
    //    until notification_preferences ships).
    try {
      if (createdNotif && process.env.RESEND_API_KEY && recipientProfile?.email) {
        // Unread message_received nudges for THIS conversation. The just-created one
        // is unread too, so >1 means a prior unread nudge already exists → throttle.
        const { data: unreadNudges } = await adminClient
          .from('notifications')
          .select('id')
          .eq('user_id', recipientId)
          .eq('type', 'message_received')
          .eq('data->>conversationId', conversationId)
          .is('read_at', null)
        const hasOtherUnreadInConversation = (unreadNudges ?? []).length > 1

        const { data: recipientPresence } = await adminClient
          .from('member_presence')
          .select('last_active_at')
          .eq('user_id', recipientId)
          .maybeSingle()

        if (shouldEmailNewMessage({
          recipientLastActiveAt: recipientPresence?.last_active_at ?? null,
          hasOtherUnreadInConversation,
        })) {
          const { data: senderProfile } = await adminClient
            .from('profiles')
            .select('full_name')
            .eq('id', user.id)
            .single()
          console.log(`[Email] type=new_message conversationId=${conversationId} recipientId=${recipientId}`)
          const { sendNewMessageEmail } = await import('@/lib/email')
          await sendNewMessageEmail(
            recipientProfile.email,
            recipientProfile.full_name || 'there',
            senderProfile?.full_name || 'A member',
            content.trim(),
          )
        }
      }
    } catch (emailErr: any) {
      console.error('[Message email] non-fatal:', emailErr?.message)
    }

    return NextResponse.json({
      success: true,
      message,
      isFirstMessage
    })

  } catch (error: any) {
    console.error('[Send Message] Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
