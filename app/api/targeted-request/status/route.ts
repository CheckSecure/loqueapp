import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  const supabase = createClient()
  
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    // Get current pending request
    const { data: pendingRequest } = await supabase
      .from('targeted_requests')
      .select('*')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .maybeSingle()

    // Get user's premium credits
    const { data: credits } = await supabase
      .from('meeting_credits')
      .select('free_credits, premium_credits')
      .eq('user_id', user.id)
      .single()

    return NextResponse.json({
      hasPendingRequest: !!pendingRequest,
      pendingRequest: pendingRequest || null,
      premiumCredits: credits?.premium_credits || 0,
      canSubmit: (credits?.premium_credits || 0) > 0 && !pendingRequest
    })

  } catch (error: any) {
    console.error('Get targeted request status error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
