import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  const supabase = createClient()
  
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    // Get all pending matches for this user
    const { data: pendingMatches, error } = await supabase
      .from('matches')
      .select(`
        id,
        user_a_id,
        user_b_id,
        created_at,
        user_a:profiles!user_a_id(id, full_name, title, company, email),
        user_b:profiles!user_b_id(id, full_name, title, company, email)
      `)
      .eq('status', 'pending_credits')
      .or(`user_a_id.eq.${user.id},user_b_id.eq.${user.id}`)
      .order('created_at', { ascending: false })

    if (error) throw error

    // Format the response to show the OTHER user in each match
    const formattedMatches = pendingMatches?.map(match => {
      const otherUser = match.user_a_id === user.id ? match.user_b : match.user_a
      return {
        matchId: match.id,
        createdAt: match.created_at,
        otherUser: {
          id: otherUser.id,
          name: otherUser.full_name,
          title: otherUser.title,
          company: otherUser.company
        }
      }
    }) || []

    return NextResponse.json({
      pendingIntroductions: formattedMatches,
      count: formattedMatches.length
    })

  } catch (error: any) {
    console.error('[List Pending] Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
