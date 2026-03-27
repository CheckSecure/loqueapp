import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const { targetId } = await req.json()

    // Delete intro_request regardless of status (pending, batched, or approved)
    const { error } = await supabase
      .from('intro_requests')
      .delete()
      .eq('requester_id', user.id)
      .eq('target_user_id', targetId)
      .in('status', ['pending', 'batched', 'approved'])

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
