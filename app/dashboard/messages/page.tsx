import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import MessagesClient from '@/components/MessagesClient'

export const metadata = { title: 'Messages | Andrel' }

export default async function MessagesPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Step 1: get all matches for this user
  const { data: matchRows, error: matchErr } = await supabase
    .from('matches')
    .select('id, user_a_id, user_b_id')
    .or(`user_a_id.eq.${user.id},user_b_id.eq.${user.id}`)

  console.log('[Messages] matchErr:', matchErr?.message ?? 'none')
  console.log('[Messages] matches:', JSON.stringify(matchRows))

  const matchIds = (matchRows || []).map((m: any) => m.id)
  const conversations: any[] = []

  if (matchIds.length > 0) {
    // Step 2: get conversations linked to those matches (with messages)
    const { data: convRows, error: convErr } = await supabase
      .from('conversations')
      .select('id, match_id, created_at, messages(id, content, sender_id, created_at)')
      .in('match_id', matchIds)

    console.log('[Messages] convErr:', convErr?.message ?? 'none')
    console.log('[Messages] conversations:', convRows?.length ?? 0)

    // Step 3: collect the other user IDs from each match
    const matchMap: Record<string, { user_a_id: string; user_b_id: string }> = {}
    for (const m of matchRows || []) {
      matchMap[m.id] = { user_a_id: m.user_a_id, user_b_id: m.user_b_id }
    }

    const otherIds = (matchRows || []).map((m: any) =>
      m.user_a_id === user.id ? m.user_b_id : m.user_a_id
    ).filter(Boolean)

    // Step 4: fetch other users' profiles
    let profileById: Record<string, any> = {}
    if (otherIds.length > 0) {
      const { data: profileRows } = await supabase
        .from('profiles')
        .select('id, full_name, title, company')
        .in('id', otherIds)
      for (const p of profileRows || []) profileById[p.id] = p
    }

    // Step 4b: auto-create conversations for matches that don't have one yet
    const matchIdsWithConvs = new Set((convRows || []).map((c: any) => c.match_id))
    for (const m of matchRows || []) {
      if (!matchIdsWithConvs.has(m.id)) {
        const { data: newConv } = await supabase
          .from('conversations')
          .insert({ match_id: m.id })
          .select('id, match_id, created_at')
          .single()
        if (newConv) {
          // Add with empty messages array
          ;(convRows as any[])?.push({ ...newConv, messages: [] })
        }
      }
    }

    // Step 5: assemble conversation objects
    for (const c of convRows || []) {
      const match = matchMap[c.match_id]
      if (!match) continue
      const otherId = match.user_a_id === user.id ? match.user_b_id : match.user_a_id
      const other = profileById[otherId] ?? null

      const sortedMessages = [...((c.messages as any[]) || [])].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      )
      const lastMsg = sortedMessages[sortedMessages.length - 1]

      conversations.push({
        id: c.id,
        other,
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
