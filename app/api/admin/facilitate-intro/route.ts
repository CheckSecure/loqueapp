import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { sendMatchCreatedEmail } from '@/lib/email'

export async function POST(request: Request) {
  const supabase = createClient()
  const adminSupabase = createAdminClient()
  const { requestId } = await request.json()

  if (!requestId) {
    return NextResponse.json({ error: 'Request ID required' }, { status: 400 })
  }

  const { data: introRequest, error: reqError } = await supabase
    .from('intro_requests')
    .select('id, requester_id, target_user_id, created_at, requester:profiles!intro_requests_requester_id_fkey(id, full_name, email, role_type, company), target:profiles!intro_requests_target_user_id_fkey(id, full_name, email, role_type, company)')
    .eq('id', requestId)
    .single()

  if (reqError || !introRequest) {
    return NextResponse.json({ error: 'Request not found' }, { status: 404 })
  }

  // Check for mutual interest (reverse request exists)
  const { data: reverseRequest } = await supabase
    .from('intro_requests')
    .select('id, created_at')
    .eq('requester_id', introRequest.target_user_id)
    .eq('target_user_id', introRequest.requester_id)
    .eq('status', 'pending')
    .single()

  if (!reverseRequest) {
    return NextResponse.json({ error: 'Mutual interest required - both users must express interest first' }, { status: 400 })
  }

  // Determine who expressed interest first
  const firstRequestTime = new Date(introRequest.created_at)
  const reverseRequestTime = new Date(reverseRequest.created_at)
  const firstPersonId = firstRequestTime < reverseRequestTime ? introRequest.requester_id : introRequest.target_user_id

  // Check credit balance of first person
  const { data: creditRow } = await adminSupabase
    .from('meeting_credits')
    .select('balance')
    .eq('user_id', firstPersonId)
    .single()

  const balance = creditRow?.balance ?? 0

  if (balance < 1) {
    return NextResponse.json({ error: 'Insufficient credits' }, { status: 400 })
  }

  // Create the match
  const { data: match, error: matchError } = await adminSupabase
    .from('matches')
    .insert({
      user_a_id: introRequest.requester_id,
      user_b_id: introRequest.target_user_id,
    })
    .select()
    .single()

  if (matchError) {
    return NextResponse.json({
      error: 'Failed to create match',
      debug: { matchError: matchError.message }
    }, { status: 500 })
  }

  // Create conversation
  const { error: convError } = await adminSupabase
    .from('conversations')
    .insert({ match_id: match.id })

  if (convError) {
    return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 })
  }

  // Deduct credit from first person
  await adminSupabase
    .from('meeting_credits')
    .update({ balance: balance - 1 })
    .eq('user_id', firstPersonId)

  // Log transaction
  await adminSupabase.from('credit_transactions').insert({
    user_id: firstPersonId,
    amount: -1,
    type: 'deduction',
    note: 'Introduction facilitated',
  })

  // Update both intro_requests to approved
  await adminSupabase
    .from('intro_requests')
    .update({ status: 'approved', credit_charged: true })
    .in('id', [requestId, reverseRequest.id])

  const requester = introRequest.requester as any
  const target = introRequest.target as any

  // Send notifications
  const notifications = [
    {
      user_id: introRequest.requester_id,
      type: 'intro_accepted',
      title: 'New Connection',
      body: `You're now connected with ${target.full_name}`,
      link: '/dashboard/network',
    },
    {
      user_id: introRequest.target_user_id,
      type: 'intro_accepted',
      title: 'New Connection',
      body: `You're now connected with ${requester.full_name}`,
      link: '/dashboard/network',
    },
  ]

  await adminSupabase.from('notifications').insert(notifications)

  // Send emails
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
