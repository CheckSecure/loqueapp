import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/requireAdmin'
import { createAdminClient } from '@/lib/supabase/admin'
import { createNotificationSafe } from '@/lib/notifications'
import { buildBidirectionalBlockFilter, buildBidirectionalMatchFilter, buildBidirectionalIntroRequestFilter } from '@/lib/db/filters'

export async function POST(req: Request) {
  const { error, user } = await requireAdmin()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const userIdA = typeof body.userIdA === 'string' ? body.userIdA : ''
  const userIdB = typeof body.userIdB === 'string' ? body.userIdB : ''
  if (!userIdA || !userIdB || userIdA === userIdB) {
    return NextResponse.json({ error: 'Two distinct user ids required' }, { status: 400 })
  }

  const admin = createAdminClient()

  // Block if either user is deactivated
  const { data: deactProfiles } = await admin
    .from('profiles')
    .select('id, full_name, account_status')
    .in('id', [userIdA, userIdB])

  const deactA = (deactProfiles || []).find(p => p.id === userIdA)
  const deactB = (deactProfiles || []).find(p => p.id === userIdB)

  if (!deactA || deactA.account_status !== 'active') {
    const name = deactA?.full_name
    return NextResponse.json({ error: `User A is no longer active${name ? ` (${name})` : ''}` }, { status: 409 })
  }
  if (!deactB || deactB.account_status !== 'active') {
    const name = deactB?.full_name
    return NextResponse.json({ error: `User B is no longer active${name ? ` (${name})` : ''}` }, { status: 409 })
  }

  // Safety check: no active block
  const { data: blocks } = await admin
    .from('blocked_users')
    .select('id')
    .or(buildBidirectionalBlockFilter(userIdA, userIdB))
    .limit(1)
  if (blocks && blocks.length > 0) {
    return NextResponse.json({ error: 'Users have an active block. Unblock first.' }, { status: 409 })
  }

  // Safety check: no duplicate active match
  const { data: existingMatches } = await admin
    .from('matches')
    .select('id, status')
    .or(buildBidirectionalMatchFilter(userIdA, userIdB))

  const activeDupe = (existingMatches || []).find(m => m.status !== 'removed')
  if (activeDupe) {
    return NextResponse.json({ error: 'Active match already exists', matchId: activeDupe.id }, { status: 409 })
  }

  // Check: existing admin-initiated intro already pending?
  const { data: existingIntros } = await admin
    .from('intro_requests')
    .select('id, status, is_admin_initiated')
    .or(buildBidirectionalIntroRequestFilter(userIdA, userIdB))
    .eq('is_admin_initiated', true)
    .in('status', ['admin_pending', 'approved'])

  if (existingIntros && existingIntros.length > 0) {
    return NextResponse.json({
      success: true,
      mode: 'intro_already_proposed',
      introRequests: existingIntros
    })
  }

  // Create TWO intro_requests in admin_pending state, both directions
  const now = new Date().toISOString()
  const { data: newIntros, error: insErr } = await admin
    .from('intro_requests')
    .insert([
      {
        requester_id: userIdA,
        target_user_id: userIdB,
        status: 'admin_pending',
        is_admin_initiated: true,
        admin_notes: 'manual_create',
        created_at: now
      },
      {
        requester_id: userIdB,
        target_user_id: userIdA,
        status: 'admin_pending',
        is_admin_initiated: true,
        admin_notes: 'manual_create',
        created_at: now
      }
    ])
    .select('id, requester_id, target_user_id')

  if (insErr || !newIntros) {
    console.error('[admin/admin-create-match] intro_requests insert failed:', insErr)
    return NextResponse.json({ error: 'Failed to propose introduction' }, { status: 500 })
  }

  // Get names for notification personalization
  const { data: profileA } = await admin
    .from('profiles')
    .select('full_name')
    .eq('id', userIdA)
    .maybeSingle()
  const { data: profileB } = await admin
    .from('profiles')
    .select('full_name')
    .eq('id', userIdB)
    .maybeSingle()

  // Send admin_intro notifications to both users
  try {
    await createNotificationSafe({
      userId: userIdA,
      type: 'admin_intro',
      data: {
        fromUserId: userIdB,
        fromUserName: profileB?.full_name || 'a curated connection'
      }
    })
    await createNotificationSafe({
      userId: userIdB,
      type: 'admin_intro',
      data: {
        fromUserId: userIdA,
        fromUserName: profileA?.full_name || 'a curated connection'
      }
    })
  } catch (e) {
    console.error('[admin/admin-create-match] notification send failed (non-fatal):', e)
  }

  console.log('[admin/admin-create-match] intro proposed:', {
    by: user?.email,
    userIdA,
    userIdB,
    introIds: newIntros.map(i => i.id)
  })

  return NextResponse.json({
    success: true,
    mode: 'intro_proposed',
    introRequests: newIntros
  })
}
