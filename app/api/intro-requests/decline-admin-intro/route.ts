import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { buildBidirectionalIntroRequestFilter } from '@/lib/db/filters'

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { introRequestId } = await request.json().catch(() => ({}))
  if (!introRequestId) {
    return NextResponse.json({ error: 'introRequestId required' }, { status: 400 })
  }

  const adminClient = createAdminClient()

  // Find the intro so we can identify the pair
  const { data: intro } = await adminClient
    .from('intro_requests')
    .select('id, requester_id, target_user_id, status, is_admin_initiated')
    .eq('id', introRequestId)
    .maybeSingle()

  if (!intro) {
    return NextResponse.json({ error: 'Intro not found' }, { status: 404 })
  }

  // Only the target of an admin intro can decline it
  if (!intro.is_admin_initiated) {
    return NextResponse.json({ error: 'This endpoint only handles admin-initiated intros' }, { status: 400 })
  }

  const isParticipant = user.id === intro.requester_id || user.id === intro.target_user_id
  if (!isParticipant) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  // Set BOTH intro_requests in this pair to declined — silent, no notification
  const { error: updErr } = await adminClient
    .from('intro_requests')
    .update({ status: 'declined', updated_at: new Date().toISOString() })
    .or(buildBidirectionalIntroRequestFilter(intro.requester_id, intro.target_user_id))
    .eq('is_admin_initiated', true)

  if (updErr) {
    console.error('[decline-admin-intro] update failed:', updErr)
    return NextResponse.json({ error: 'Failed to decline intro' }, { status: 500 })
  }

  console.log('[AdminIntro] Declined silently', {
    userId: user.id,
    targetUserId: user.id === intro.requester_id ? intro.target_user_id : intro.requester_id
  })

  return NextResponse.json({ success: true })
}
