import { createClient } from '@/lib/supabase/server'
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
    // Verify user is part of this conversation
    const { data: conversation } = await supabase
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

    // Verify user is part of match
    if (match.user_a_id !== user.id && match.user_b_id !== user.id) {
      return NextResponse.json({ 
        error: 'Unauthorized' 
      }, { status: 403 })
    }

    // Get messages
    const { data: messages, error } = await supabase
      .from('messages')
      .select('*, sender:profiles(id, full_name, title, company)')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })

    if (error) throw error

    // Get suggested prompts from conversation
    const suggestedPrompts = conversation.suggested_prompts || []

    return NextResponse.json({
      messages: messages || [],
      suggestedPrompts,
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
