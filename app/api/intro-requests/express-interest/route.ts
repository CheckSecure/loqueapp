import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { sendMatchCreatedEmail } from '@/lib/email'

export async function POST(request: Request) {
  const supabase = createClient()
  
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { introRequestId } = await request.json()

  try {
    // Get the intro request
    const { data: introRequest } = await supabase
      .from('intro_requests')
      .select('*, requester:profiles!requester_id(*), target:profiles!target_user_id(*)')
      .eq('id', introRequestId)
      .single()

    if (!introRequest) throw new Error('Intro request not found')

    // Determine who is expressing interest and who is the other party
    const isRequester = user.id === introRequest.requester_id
    const expresserId = user.id
    const otherUserId = isRequester ? introRequest.target_user_id : introRequest.requester_id

    // Update intro request status to 'approved'
    await supabase
      .from('intro_requests')
      .update({ status: 'approved' })
      .eq('id', introRequestId)

    // Check for mutual interest (reverse intro request)
    const { data: reverseRequest } = await supabase
      .from('intro_requests')
      .select('*')
      .eq('requester_id', otherUserId)
      .eq('target_user_id', expresserId)
      .eq('status', 'approved')
      .maybeSingle()

    // If mutual interest exists, auto-create the match
    if (reverseRequest) {
      console.log('[Auto-Match] Mutual interest detected, creating match...')

      // Check if match already exists
      const { data: existingMatch } = await supabase
        .from('matches')
        .select('id')
        .or(`and(user_a_id.eq.${expresserId},user_b_id.eq.${otherUserId}),and(user_a_id.eq.${otherUserId},user_b_id.eq.${expresserId})`)
        .maybeSingle()

      if (existingMatch) {
        return NextResponse.json({ 
          success: true, 
          mutualInterest: true,
          matchAlreadyExists: true 
        })
      }

      // Create the match using admin client to bypass RLS
      const { data: match, error: matchError } = await adminClient
        .from('matches')
        .insert({
          user_a_id: expresserId,
          user_b_id: otherUserId,
          status: 'active',
          admin_facilitated: false,
          created_at: new Date().toISOString()
        })
        .select()
        .single()

      if (matchError) {
        console.error('Match creation error:', matchError)
        throw matchError
      }

      // Create conversation
      const adminClient = createAdminClient()
      await adminClient.from('conversations').insert({
        match_id: match.id
      })

      // Get full profile data
      const { data: expresserProfile } = await supabase
        .from('profiles')
        .select('full_name, email, title, company')
        .eq('id', expresserId)
        .single()

      const { data: otherProfile } = await supabase
        .from('profiles')
        .select('full_name, email, title, company')
        .eq('id', otherUserId)
        .single()

      // Send notifications to both users
      await adminClient.from('notifications').insert([
        {
          user_id: expresserId,
          type: 'new_connection',
          title: 'Introduction facilitated',
          body: `You're now connected with ${otherProfile?.full_name}`,
          link: '/dashboard/network',
          created_at: new Date().toISOString()
        },
        {
          user_id: otherUserId,
          type: 'new_connection',
          title: 'Introduction facilitated',
          body: `You're now connected with ${expresserProfile?.full_name}`,
          link: '/dashboard/network',
          created_at: new Date().toISOString()
        }
      ])

      // Send emails
      if (expresserProfile?.email) {
        try {
          await sendMatchCreatedEmail(
            expresserProfile.email,
            expresserProfile.full_name || 'there',
            otherProfile?.full_name || 'New Connection',
            otherProfile?.title,
            otherProfile?.company
          )
        } catch (e) {
          console.error('Email error:', e)
        }
      }

      if (otherProfile?.email) {
        try {
          await sendMatchCreatedEmail(
            otherProfile.email,
            otherProfile.full_name || 'there',
            expresserProfile?.full_name || 'New Connection',
            expresserProfile?.title,
            expresserProfile?.company
          )
        } catch (e) {
          console.error('Email error:', e)
        }
      }

      // Handle credits (charge the original requester)
      const initiatorId = introRequest.created_at < reverseRequest.created_at 
        ? introRequest.requester_id 
        : reverseRequest.requester_id

      const { data: credits } = await supabase
        .from('meeting_credits')
        .select('balance')
        .eq('user_id', initiatorId)
        .single()

      if (credits && credits.balance > 0) {
        await supabase
          .from('meeting_credits')
          .update({ balance: credits.balance - 1 })
          .eq('user_id', initiatorId)
      }

      return NextResponse.json({
        success: true,
        mutualInterest: true,
        matchCreated: true,
        matchId: match.id
      })
    }

    // No mutual interest yet - just approved the intro request
    return NextResponse.json({
      success: true,
      mutualInterest: false,
      message: 'Interest expressed successfully'
    })

  } catch (error: any) {
    console.error('Express interest error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
