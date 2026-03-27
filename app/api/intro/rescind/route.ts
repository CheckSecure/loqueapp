import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const { targetId } = await req.json()

    // First check what intro_requests exist for this target
    const { data: existing } = await supabase
      .from('intro_requests')
      .select('id, status, requester_id, target_user_id')
      .eq('requester_id', user.id)
      .eq('target_user_id', targetId)

    console.log('Existing intro_requests:', existing)

    // Delete intro_request regardless of status
    const { data, error } = await supabase
      .from('intro_requests')
      .delete()
      .eq('requester_id', user.id)
      .eq('target_user_id', targetId)
      .in('status', ['pending', 'batched', 'approved'])
      .select()

    console.log('Delete result:', { deleted: data?.length || 0, targetId })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, deleted: data?.length || 0, existing })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
