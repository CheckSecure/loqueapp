import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { sendMatchCreatedEmail } from '@/lib/email'

export async function POST(request: Request) {
  const supabase = createClient()
  const adminClient = createAdminClient()
  
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { matchId } = await request.json()

  try {
    // Get the pending match
    const { data: match } = await adminClient
      .from('matches')
      .select('*, user_a:profiles!user_a_id(*), user_b:profiles!user_b_id(*)')
      .eq('id', matchId)
      .eq('status', 'pending_credits')
      .single()

    if (!match) {
      return NextResponse.json({
        error: 'Pending introduction not found'
      }, { status: 404 })
    }

    // Verify user is part of this match
    if (match.user_a_id !== user.id && match.user_b_id !== user.id) {
      return NextResponse.json({
        error: 'Unauthorized'
      }, { status: 403 })
    }

    // Check if BOTH users now have credits
    const { data: userACredits } = await adminClient
      .from('meeting_credits')
      .select('free_credits, premium_credits')
      .eq('user_id', match.user_a_id)
      .single()

    const { data: userBCredits } = await adminClient
      .from('meeting_credits')
      .select('free_credits, premium_credits')
      .eq('user_id', match.user_b_id)
      .single()

    const userAHasCredits = (userACredits?.free_credits || 0) >= 1
    const userBHasCredits = (userBCredits?.free_credits || 0) >= 1

    if (!userAHasCredits || !userBHasCredits) {
      return NextResponse.json({
        error: 'Insufficient credits',
        message: userAHasCredits 
          ? 'The other user needs to add credits to proceed.'
          : 'You need at least 1 free credit to activate this introduction.',
        userAHasCredits,
        userBHasCredits
      }, { status: 403 })
    }

    // Both have credits - activate the match!
    
    // Deduct credits from both users
    await adminClient
      .from('meeting_credits')
      .update({
        free_credits: (userACredits?.free_credits || 0) - 1,
        balance: ((userACredits?.free_credits || 0) - 1) + (userACredits?.premium_credits || 0)
      })
      .eq('user_id', match.user_a_id)

    await adminClient
      .from('meeting_credits')
      .update({
        free_credits: (userBCredits?.free_credits || 0) - 1,
        balance: ((userBCredits?.free_credits || 0) - 1) + (userBCredits?.premium_credits || 0)
      })
      .eq('user_id', match.user_b_id)

    // Update match status to active
    await adminClient
      .from('matches')
      .update({ status: 'active' })
      .eq('id', matchId)

    // Create conversation
    await adminClient.from('conversations').insert({
      match_id: matchId
    })

    // Send notifications
    await adminClient.from('notifications').insert([
      {
        user_id: match.user_a_id,
        type: 'new_connection',
        title: 'Your introduction is ready',
        body: `You're now connected with ${match.user_b.full_name}. Start a conversation.`,
        link: '/dashboard/network',
        created_at: new Date().toISOString()
      },
      {
        user_id: match.user_b_id,
        type: 'new_connection',
        title: 'Your introduction is ready',
        body: `You're now connected with ${match.user_a.full_name}. Start a conversation.`,
        link: '/dashboard/network',
        created_at: new Date().toISOString()
      }
    ])

    // Send emails
    if (match.user_a.email && match.user_b) {
      sendMatchCreatedEmail({
        to: match.user_a.email,
        matchName: match.user_b.full_name || 'Your connection',
        matchTitle: match.user_b.title,
        matchCompany: match.user_b.company
      }).catch(e => console.error('Email error:', e))
    }

    if (match.user_b.email && match.user_a) {
      sendMatchCreatedEmail({
        to: match.user_b.email,
        matchName: match.user_a.full_name || 'Your connection',
        matchTitle: match.user_a.title,
        matchCompany: match.user_a.company
      }).catch(e => console.error('Email error:', e))
    }

    console.log('[Pending Introduction] Activated:', {
      matchId,
      userA: match.user_a_id,
      userB: match.user_b_id
    })

    return NextResponse.json({
      success: true,
      matchId,
      message: 'Introduction activated successfully'
    })

  } catch (error: any) {
    console.error('[Activate Pending] Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
