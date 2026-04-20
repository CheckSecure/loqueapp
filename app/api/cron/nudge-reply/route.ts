import { createAdminClient } from '@/lib/supabase/admin'
import { createNotificationSafe } from '@/lib/notifications'
import { NextResponse } from 'next/server'

export async function GET() {
  const adminClient = createAdminClient()

  try {
    // Find active matches from 72+ hours ago with no messages
    const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString()

    // Get active matches older than 72 hours
    const { data: oldMatches } = await adminClient
      .from('matches')
      .select('id, user_a_id, user_b_id, created_at')
      .eq('status', 'active')
      .lte('created_at', seventyTwoHoursAgo)

    if (!oldMatches || oldMatches.length === 0) {
      return NextResponse.json({ 
        success: true, 
        message: 'No old matches to check' 
      })
    }

    const matchIds = oldMatches.map(m => m.id)

    // Get conversations for these matches
    const { data: conversations } = await adminClient
      .from('conversations')
      .select('id, match_id')
      .in('match_id', matchIds)

    const conversationIds = conversations?.map(c => c.id) || []

    if (conversationIds.length === 0) {
      return NextResponse.json({ 
        success: true, 
        message: 'No conversations found' 
      })
    }

    // Check which conversations have no messages
    const { data: messages } = await adminClient
      .from('messages')
      .select('conversation_id')
      .in('conversation_id', conversationIds)

    const conversationsWithMessages = new Set(messages?.map(m => m.conversation_id) || [])

    // Find matches with no messages
    const matchesNeedingNudge = oldMatches.filter(match => {
      const conversation = conversations?.find(c => c.match_id === match.id)
      return conversation && !conversationsWithMessages.has(conversation.id)
    })

    if (matchesNeedingNudge.length === 0) {
      return NextResponse.json({ 
        success: true, 
        message: 'All matches have messages' 
      })
    }

    // Check if users were already nudged recently
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    
    const { data: recentNudges } = await adminClient
      .from('notifications')
      .select('user_id')
      .eq('type', 'nudge_reply')
      .gte('created_at', oneDayAgo)

    const recentlyNudgedUserIds = new Set(recentNudges?.map(n => n.user_id) || [])

    // Create notifications for both users in each match
    const notifications: any[] = []

    for (const match of matchesNeedingNudge) {
      const conversation = conversations?.find(c => c.match_id === match.id)
      
      if (!recentlyNudgedUserIds.has(match.user_a_id)) {
        notifications.push({
          userId: match.user_a_id,
          type: 'nudge_reply' as const,
          title: 'Your introduction is waiting',
          message: 'Your connection is waiting to hear from you.',
          data: {
            matchId: match.id,
            conversationId: conversation?.id
          }
        })
      }

      if (!recentlyNudgedUserIds.has(match.user_b_id)) {
        notifications.push({
          userId: match.user_b_id,
          type: 'nudge_reply' as const,
          title: 'Your introduction is waiting',
          message: 'Your connection is waiting to hear from you.',
          data: {
            matchId: match.id,
            conversationId: conversation?.id
          }
        })
      }
    }

    if (notifications.length === 0) {
      return NextResponse.json({ 
        success: true, 
        message: 'All users were recently nudged' 
      })
    }

    // Create notifications using safe method
    for (const notif of notifications) {
      await createNotificationSafe({
        userId: notif.userId,
        type: notif.type,
        data: notif.data
      })
    }

    console.log(`[Nudge Reply] Sent ${notifications.length} nudge notifications`)

    return NextResponse.json({ 
      success: true, 
      message: `Nudged ${notifications.length} users`,
      count: notifications.length
    })
  } catch (error: any) {
    console.error('[Nudge Reply] Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
