import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || user.email !== 'bizdev91@gmail.com') {
      return NextResponse.json({ error: 'Not authorized' }, { status: 401 })
    }

    const { requestId, userAId, userBId } = await req.json()
    if (!requestId) return NextResponse.json({ error: 'Missing requestId' }, { status: 400 })

    const adminClient = createAdminClient()

    // Get the request to find user IDs if not provided
    const { data: introRequest } = await adminClient
      .from('intro_requests')
      .select('requester_id, target_user_id')
      .eq('id', requestId)
      .single()

    if (!introRequest) return NextResponse.json({ error: 'Request not found' }, { status: 404 })

    const aId = userAId || introRequest.requester_id
    const bId = userBId || introRequest.target_user_id

    // Get both user names for notifications
    const { data: profiles } = await adminClient
      .from('profiles')
      .select('id, full_name')
      .in('id', [aId, bId])

    const userA = profiles?.find(p => p.id === aId)
    const userB = profiles?.find(p => p.id === bId)

    // Check if match already exists
    const { data: existingMatch } = await adminClient
      .from('matches')
      .select('id')
      .or(`and(user_a_id.eq.${aId},user_b_id.eq.${bId}),and(user_a_id.eq.${bId},user_b_id.eq.${aId})`)
      .limit(1)
      .single()

    let matchId = existingMatch?.id

    if (!matchId) {
      // Create match
      const { data: newMatch, error: matchError } = await adminClient
        .from('matches')
        .insert({ user_a_id: aId, user_b_id: bId })
        .select('id')
        .single()

      if (matchError) {
        console.error('[facilitate] match insert error:', matchError.message)
        return NextResponse.json({ error: matchError.message }, { status: 500 })
      }
      matchId = newMatch.id
    }

    // Create conversation if not exists
    const { data: existingConv } = await adminClient
      .from('conversations')
      .select('id')
      .eq('match_id', matchId)
      .limit(1)
      .single()

    if (!existingConv) {
      await adminClient.from('conversations').insert({ match_id: matchId })
    }

    // Send notifications to both users
    const notifications = [
      {
        user_id: aId,
        type: 'intro_accepted',
        title: 'New Connection!',
        body: `You're now connected with ${userB?.full_name || 'your match'}. Start a conversation in your Network.`,
        link: '/dashboard/network',
      },
      {
        user_id: bId,
        type: 'intro_accepted',
        title: 'New Connection!',
        body: `You're now connected with ${userA?.full_name || 'your match'}. Start a conversation in your Network.`,
        link: '/dashboard/network',
      },
    ]

    const { error: notifErr } = await adminClient
      .from('notifications')
      .insert(notifications)

    if (notifErr) {
      console.warn('[facilitate] notification insert failed:', notifErr.message)
    } else {
      console.log('[facilitate] notifications sent to both users')
    }

    // Mark both requests as accepted
    await adminClient
      .from('intro_requests')
      .update({ status: 'accepted' })
      .or(`and(requester_id.eq.${aId},target_user_id.eq.${bId}),and(requester_id.eq.${bId},target_user_id.eq.${aId})`)

    console.log('[facilitate] intro facilitated between', aId, 'and', bId)
    return NextResponse.json({ success: true, matchId })
  } catch (err: any) {
    console.error('[facilitate] error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
