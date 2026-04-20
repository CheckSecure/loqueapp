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

    // ✅ NO CREDIT DEDUCTION - users already paid when expressing interest
    // Just activate the match that's been waiting

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
      sendMatchCreatedEmail(
        match.user_a.email,
        match.user_a.full_name || 'User',
        match.user_b.full_name || 'Your connection',
        match.user_b.title,
        match.user_b.company
      ).catch(e => console.error('Email error:', e))
    }

    if (match.user_b.email && match.user_a) {
      sendMatchCreatedEmail(
        match.user_b.email,
        match.user_b.full_name || 'User',
        match.user_a.full_name || 'Your connection',
        match.user_a.title,
        match.user_a.company
      ).catch(e => console.error('Email error:', e))
    }

    console.log('[Pending Introduction] Activated (no charge):', {
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
