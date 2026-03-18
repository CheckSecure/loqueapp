import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import MessagesClient from '@/components/MessagesClient'
import pool from '@/lib/db'

export const metadata = { title: 'Messages | Cadre' }

export default async function MessagesPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Fetch all conversations the user is part of
  const { rows: convRows } = await pool.query(
    `SELECT DISTINCT cp.conversation_id
     FROM conversation_participants cp
     WHERE cp.user_id = $1`,
    [user.id]
  )

  const conversations: any[] = []

  for (const row of convRows) {
    const cid = row.conversation_id

    // Get other participant
    const { rows: otherRows } = await pool.query(
      `SELECT p.id, p.full_name, p.role, p.company, p.avatar_color
       FROM conversation_participants cp
       JOIN profiles p ON p.id = cp.user_id
       WHERE cp.conversation_id = $1 AND cp.user_id != $2
       LIMIT 1`,
      [cid, user.id]
    )

    // Get messages
    const { rows: msgRows } = await pool.query(
      `SELECT id, content, sender_id, created_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [cid]
    )

    const lastMsg = msgRows[msgRows.length - 1]
    conversations.push({
      id: cid,
      other: otherRows[0] || null,
      messages: msgRows,
      lastMessage: lastMsg?.content || '',
      lastTime: lastMsg?.created_at || new Date(0).toISOString(),
    })
  }

  conversations.sort((a, b) =>
    new Date(b.lastTime).getTime() - new Date(a.lastTime).getTime()
  )

  return <MessagesClient conversations={conversations} currentUserId={user.id} />
}
