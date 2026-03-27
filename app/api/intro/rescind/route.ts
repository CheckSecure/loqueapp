import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    // Get user auth from regular client
    const userClient = createClient()
    const { data: { user } } = await userClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const { targetId } = await req.json()
    
    // Use admin client to bypass RLS
    const adminClient = createAdminClient()
    const { data, error } = await adminClient
      .from('intro_requests')
      .delete()
      .eq('requester_id', user.id)
      .eq('target_user_id', targetId)
      .select()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, deleted: data?.length || 0 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
