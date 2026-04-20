import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createNotificationSafe } from '@/lib/notifications'
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

    // Send notification to recipient
    await createNotificationSafe({
      userId: recipientId,
      type: 'message_received',
      data: {
        conversationId,
        fromUserId: user.id
      }
    })

    console.log('[Message Sent]:', {
      conversationId,
      senderId: user.id,
      recipientId,
      isFirstMessage
    })

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
