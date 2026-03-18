import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import MessagesClient from '@/components/MessagesClient'

export const metadata = { title: 'Messages | Cadre' }

export default async function MessagesPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Get all conversations this user participates in
  const { data: participantRows } = await supabase
    .from('conversation_participants')
    .select('conversation_id')
    .eq('user_id', user.id)

  const conversationIds = (participantRows || []).map(r => r.conversation_id)
  const conversations: any[] = []

  if (conversationIds.length > 0) {
    // Fetch conversations with nested participants + messages
    const { data: convData } = await supabase
      .from('conversations')
      .select(`
        id,
        created_at,
        conversation_participants(user_id, profiles(id, full_name, role, company)),
        messages(id, content, sender_id, created_at)
      `)
      .in('id', conversationIds)

    for (const c of convData || []) {
      const otherParticipant = (c.conversation_participants as any[])
        ?.find((p: any) => p.user_id !== user.id)?.profiles

      const sortedMessages = [...((c.messages as any[]) || [])].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      )
      const lastMsg = sortedMessages[sortedMessages.length - 1]

      conversations.push({
        id: c.id,
        other: otherParticipant || null,
        messages: sortedMessages,
        lastMessage: lastMsg?.content || '',
        lastTime: lastMsg?.created_at || c.created_at,
      })
    }

    conversations.sort((a, b) =>
      new Date(b.lastTime).getTime() - new Date(a.lastTime).getTime()
    )
  }

  return <MessagesClient conversations={conversations} currentUserId={user.id} />
}
