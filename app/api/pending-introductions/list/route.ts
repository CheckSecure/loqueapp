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
        created_at
      `)
      .eq('status', 'pending_credits')
      .or(`user_a_id.eq.${user.id},user_b_id.eq.${user.id}`)
      .order('created_at', { ascending: false })

    if (error) throw error

    // Get profile data for all users in these matches
    const userIds = new Set<string>()
    pendingMatches?.forEach(match => {
      userIds.add(match.user_a_id)
      userIds.add(match.user_b_id)
    })

    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, title, company')
      .in('id', Array.from(userIds))

    const profileMap = new Map(profiles?.map(p => [p.id, p]) || [])

    // Format the response to show the OTHER user in each match
    const formattedMatches = pendingMatches?.map(match => {
      const otherUserId = match.user_a_id === user.id ? match.user_b_id : match.user_a_id
      const otherUser = profileMap.get(otherUserId)
      
      return {
        matchId: match.id,
        createdAt: match.created_at,
        otherUser: {
          id: otherUserId,
          name: otherUser?.full_name || 'Unknown',
          title: otherUser?.title,
          company: otherUser?.company
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
