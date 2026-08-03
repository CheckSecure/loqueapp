import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

/**
 * Decline incoming member-initiated interest (the "Interested in you" surface).
 *
 * `introRequestId` is the EXPRESSER's row (requester = interested member, target =
 * viewer). Declining resolves that request WITHOUT creating any reciprocal interest
 * and WITHOUT charging a credit — the expresser's row becomes 'declined', which
 * removes it from the actionable surface and the reminder query (both key off
 * status 'approved'). Silent: the expresser gets no notification. Idempotent.
 */
export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { introRequestId } = await request.json().catch(() => ({}))
  if (!introRequestId) {
    return NextResponse.json({ error: 'introRequestId required' }, { status: 400 })
  }

  const adminClient = createAdminClient()

  const { data: incoming } = await adminClient
    .from('intro_requests')
    .select('id, requester_id, target_user_id, status, is_admin_initiated')
    .eq('id', introRequestId)
    .maybeSingle()

  if (!incoming) {
    return NextResponse.json({ error: 'Intro request not found' }, { status: 404 })
  }
  // Only the target of a member-initiated incoming request may decline it here.
  if (incoming.is_admin_initiated) {
    return NextResponse.json({ error: 'This endpoint only handles member-initiated incoming interest' }, { status: 400 })
  }
  if (incoming.target_user_id !== user.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const { error: updErr } = await adminClient
    .from('intro_requests')
    .update({ status: 'declined', updated_at: new Date().toISOString() })
    .eq('id', introRequestId)
    .eq('is_admin_initiated', false)
  if (updErr) {
    console.error('[decline-incoming] update failed:', updErr)
    return NextResponse.json({ error: 'Failed to decline' }, { status: 500 })
  }

  // Retire any outstanding "waiting on your response" reminder for this pair so a
  // stale unread nudge can't keep pointing at a now-declined request.
  try {
    await adminClient
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('type', 'waiting_response')
      .eq('user_id', user.id)
      .is('read_at', null)
      .eq('data->>fromUserId', incoming.requester_id)
  } catch (e: any) {
    console.error('[decline-incoming] retire reminder failed (non-fatal):', e?.message)
  }

  return NextResponse.json({ success: true })
}
