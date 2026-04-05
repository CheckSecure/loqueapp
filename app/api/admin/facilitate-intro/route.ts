import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { sendMatchCreatedEmail } from '@/lib/email'

export async function POST(request: Request) {
  const supabase = createClient()
  const { requestId } = await request.json()

  if (!requestId) {
    return NextResponse.json({ error: 'Request ID required' }, { status: 400 })
  }

  // DEBUG: Check who we are
  const { data: { user } } = await supabase.auth.getUser()
  console.log('[facilitate-intro] Current user:', user?.id, user?.email)

  // DEBUG: Check if we can read intro_requests at all
  const { data: allRequests, error: allError } = await supabase
    .from('intro_requests')
    .select('id')
    .limit(5)
  console.log('[facilitate-intro] Can read any requests?', allRequests?.length, 'Error:', allError)

  // Get the intro request
  const { data: introRequest, error: reqError } = await supabase
    .from('intro_requests')
    .select('id, requester_id, target_user_id, requester:profiles!intro_requests_requester_id_fkey(id, full_name, email, role, company), target:profiles!intro_requests_target_user_id_fkey(id, full_name, email, role, company)')
    .eq('id', requestId)
    .single()

  console.log('[facilitate-intro] Query result:', { introRequest, reqError })

  if (reqError || !introRequest) {
    return NextResponse.json({ error: 'Request not found', debug: { reqError, requestId, userId: user?.id } }, { status: 404 })
  }

  const requester = introRequest.requester as any
  const target = introRequest.target as any

  // Create match
  const { data: match, error: matchError } = await supabase
    .from('matches')
    .insert({
      user_a_id: introRequest.requester_id,
      user_b_id: introRequest.target_user_id,
    })
    .select()
    .single()

  if (matchError) {
    return NextResponse.json({ error: 'Failed to create match' }, { status: 500 })
  }

  // Create conversation
  const { error: convError } = await supabase
    .from('conversations')
    .insert({ match_id: match.id })

  if (convError) {
    return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 })
  }

  // Mark request as approved
  await supabase
    .from('intro_requests')
    .update({ status: 'approved' })
    .eq('id', requestId)

  // Create notifications for both users
  const notifications = [
    {
      user_id: introRequest.requester_id,
      type: 'intro_accepted',
      body: `Your introduction to ${target.full_name} has been facilitated`,
      link: '/dashboard/network',
    },
    {
      user_id: introRequest.target_user_id,
      type: 'intro_accepted',
      body: `Your introduction to ${requester.full_name} has been facilitated`,
      link: '/dashboard/network',
    },
  ]

  await supabase.from('notifications').insert(notifications)

  // Send emails to both users
  try {
    await Promise.all([
      sendMatchCreatedEmail(
        requester.email,
        requester.full_name,
        target.full_name,
        target.role,
        target.company
      ),
      sendMatchCreatedEmail(
        target.email,
        target.full_name,
        requester.full_name,
        requester.role,
        requester.company
      ),
    ])
  } catch (emailError) {
    console.error('Failed to send match emails:', emailError)
  }

  return NextResponse.json({ success: true, match })
}
