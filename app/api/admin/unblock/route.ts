import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/requireAdmin'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildBidirectionalBlockFilter } from '@/lib/db/filters'

export async function POST(req: Request) {
  const { error, user } = await requireAdmin()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const userIdA = typeof body.userIdA === 'string' ? body.userIdA : ''
  const userIdB = typeof body.userIdB === 'string' ? body.userIdB : ''

  if (!userIdA || !userIdB) {
    return NextResponse.json({ error: 'userIdA and userIdB required' }, { status: 400 })
  }

  const admin = createAdminClient()

  // Remove blocks in either direction
  const { error: delErr, count } = await admin
    .from('blocked_users')
    .delete({ count: 'exact' })
    .or(buildBidirectionalBlockFilter(userIdA, userIdB))

  if (delErr) {
    console.error('[admin/unblock] error:', delErr)
    return NextResponse.json({ error: 'Failed to unblock' }, { status: 500 })
  }

  console.log('[admin/unblock]', { by: user?.email, userIdA, userIdB, removed: count })
  return NextResponse.json({ success: true, removed: count || 0 })
}
