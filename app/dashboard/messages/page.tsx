import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import MessagesClient from '@/components/MessagesClient'

export const metadata = { title: 'Messages | Cadre' }

export default async function MessagesPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Get conversations the user is part of
  const { data: participantRows } = await supabase
    .from('conversation_participants')
    .select('conversation_id')
    .eq('user_id', user.id)

  const conversationIds = (participantRows || []).map(r => r.conversation_id)

  let conversations: any[] = []

  if (conversationIds.length > 0) {
    // For each conversation, get the other participant's profile and latest message
    const { data: convData } = await supabase
      .from('conversations')
      .select(`
        id,
        created_at,
        conversation_participants(user_id, profiles(id, full_name, role, company, avatar_color)),
        messages(id, content, sender_id, created_at)
      `)
      .in('id', conversationIds)
      .order('created_at', { referencedTable: 'messages', ascending: false })

    conversations = (convData || []).map((c: any) => {
      const otherParticipant = c.conversation_participants
        ?.find((p: any) => p.user_id !== user.id)?.profiles
      const sortedMessages = [...(c.messages || [])].sort(
        (a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      )
      const lastMsg = sortedMessages[sortedMessages.length - 1]
      return {
        id: c.id,
        other: otherParticipant,
        messages: sortedMessages,
        lastMessage: lastMsg?.content || '',
        lastTime: lastMsg?.created_at || c.created_at,
      }
    }).sort((a: any, b: any) => new Date(b.lastTime).getTime() - new Date(a.lastTime).getTime())
  }

  return <MessagesClient conversations={conversations} currentUserId={user.id} />
}
