import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { sendMatchCreatedEmail } from '@/lib/email'

export async function POST(request: Request) {
  const supabase = createClient()
  const { requestId } = await request.json()

  if (!requestId) {
    return NextResponse.json({ error: 'Request ID required' }, { status: 400 })
  }

  const { data: introRequest, error: reqError } = await supabase
    .from('intro_requests')
    .select('id, requester_id, target_user_id, requester:profiles!intro_requests_requester_id_fkey(id, full_name, email, role_type, company), target:profiles!intro_requests_target_user_id_fkey(id, full_name, email, role_type, company)')
    .eq('id', requestId)
    .single()

  if (reqError || !introRequest) {
    return NextResponse.json({ error: 'Request not found' }, { status: 404 })
  }

  const requester = introRequest.requester as any
  const target = introRequest.target as any

  console.log('[facilitate-intro] Creating match:', {
    user_a_id: introRequest.requester_id,
    user_b_id: introRequest.target_user_id
  })

  const { data: match, error: matchError } = await supabase
    .from('matches')
    .insert({
      user_a_id: introRequest.requester_id,
      user_b_id: introRequest.target_user_id,
    })
    .select()
    .single()

  console.log('[facilitate-intro] Match creation result:', { match, matchError })

  if (matchError) {
    return NextResponse.json({
      error: 'Failed to create match',
      debug: {
        matchError: matchError.message,
        code: matchError.code,
        details: matchError.details
      }
    }, { status: 500 })
  }

  const { error: convError } = await supabase
    .from('conversations')
    .insert({ match_id: match.id })

  if (convError) {
    return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 })
  }

  await supabase
    .from('intro_requests')
    .update({ status: 'approved' })
    .eq('id', requestId)

  const notifications = [
    {
      user_id: introRequest.requester_id,
      type: 'new_connection',
      title: 'New Connection',
      body: `You're now connected with ${target.full_name}`,
      link: '/dashboard/network',
    },
    {
      user_id: introRequest.target_user_id,
      type: 'new_connection',
      title: 'New Connection',
      body: `You're now connected with ${requester.full_name}`,
      link: '/dashboard/network',
    },
  ]

  console.log('[facilitate-intro] Inserting notifications:', notifications)
  const { data: notifData, error: notifError } = await supabase
    .from('notifications')
    .insert(notifications)
    .select()
  
  console.log('[facilitate-intro] Notification result:', { notifData, notifError })

  try {
    await Promise.all([
      sendMatchCreatedEmail(
        requester.email,
        requester.full_name,
        target.full_name,
        target.role_type,
        target.company
      ),
      sendMatchCreatedEmail(
        target.email,
        target.full_name,
        requester.full_name,
        requester.role_type,
        requester.company
      ),
    ])
  } catch (emailError) {
    console.error('Failed to send match emails:', emailError)
  }

  return NextResponse.json({ success: true, match })
}
