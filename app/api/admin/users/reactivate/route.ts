import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/requireAdmin'
import { createAdminClient } from '@/lib/supabase/admin'

export async function POST(req: Request) {
  const { error, user: admin } = await requireAdmin()
  if (error) return error
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const userId = typeof body.userId === 'string' ? body.userId.trim() : ''

  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }

  const adminClient = createAdminClient()

  const { data: updated, error: profileErr } = await adminClient
    .from('profiles')
    .update({
      account_status: 'active',
      deactivated_at: null,
      deactivated_by: null,
      deactivation_reason: null,
    })
    .eq('id', userId)
    .select('id')

  if (profileErr) {
    console.error('[admin/reactivate] profile update failed:', profileErr)
    return NextResponse.json({ error: profileErr.message }, { status: 500 })
  }
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  console.log({ by: admin.email, target_user_id: userId })

  return NextResponse.json({ success: true })
}
