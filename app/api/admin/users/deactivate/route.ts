import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/requireAdmin'
import { createAdminClient } from '@/lib/supabase/admin'

export async function POST(req: Request) {
  const { error, user: admin } = await requireAdmin()
  if (error) return error
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const userId = typeof body.userId === 'string' ? body.userId.trim() : ''
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''

  if (!userId || !reason) {
    return NextResponse.json({ error: 'userId and reason are required' }, { status: 400 })
  }

  const adminClient = createAdminClient()

  // Cancel future meetings first — profile untouched if this fails, admin can retry cleanly
  const { data: cancelledMeetings, error: meetingErr } = await adminClient
    .from('meetings')
    .update({ status: 'cancelled' })
    .or(`requester_id.eq.${userId},recipient_id.eq.${userId}`)
    .in('status', ['confirmed', 'requested', 'scheduled'])
    .gt('scheduled_at', new Date().toISOString())
    .select('id')

  if (meetingErr) {
    console.error('[admin/deactivate] meeting cancellation failed:', meetingErr)
    return NextResponse.json({ error: meetingErr.message }, { status: 500 })
  }

  const { data: updated, error: profileErr } = await adminClient
    .from('profiles')
    .update({
      account_status: 'deactivated',
      deactivated_at: new Date().toISOString(),
      deactivated_by: admin.id,
      deactivation_reason: reason,
    })
    .eq('id', userId)
    .select('id')

  if (profileErr) {
    console.error('[admin/deactivate] profile update failed:', profileErr)
    return NextResponse.json({ error: profileErr.message }, { status: 500 })
  }
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const count = (cancelledMeetings ?? []).length

  console.log({
    by: admin.email,
    target_user_id: userId,
    reason,
    meetings_cancelled: count,
  })

  return NextResponse.json({ success: true, meetingsCancelled: count })
}
