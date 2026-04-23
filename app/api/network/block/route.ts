import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildBidirectionalMatchFilter } from '@/lib/db/filters'

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const matchId: string | undefined = body.matchId
  const targetUserIdInput: string | undefined = body.targetUserId
  if (!matchId && !targetUserIdInput) {
    return NextResponse.json({ error: 'matchId or targetUserId required' }, { status: 400 })
  }

  const admin = createAdminClient()

  let targetUserId = targetUserIdInput as string | undefined

  if (matchId) {
    const { data: match, error: matchErr } = await admin
      .from('matches')
      .select('id, user_a_id, user_b_id')
      .eq('id', matchId)
      .maybeSingle()
    if (matchErr || !match) {
      return NextResponse.json({ error: 'Match not found' }, { status: 404 })
    }
    if (match.user_a_id !== user.id && match.user_b_id !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    targetUserId = match.user_a_id === user.id ? match.user_b_id : match.user_a_id
  }

  if (!targetUserId) {
    return NextResponse.json({ error: 'Could not resolve target user' }, { status: 400 })
  }
  if (targetUserId === user.id) {
    return NextResponse.json({ error: 'Cannot block yourself' }, { status: 400 })
  }

  // Insert block record (idempotent via UNIQUE constraint)
  const { error: blockErr } = await admin
    .from('blocked_users')
    .upsert(
      { user_id: user.id, blocked_user_id: targetUserId },
      { onConflict: 'user_id,blocked_user_id', ignoreDuplicates: true }
    )

  if (blockErr) {
    console.error('[network/block] insert error:', blockErr)
    return NextResponse.json({ error: 'Failed to block user' }, { status: 500 })
  }

  // Also mark the existing match (if any) as removed so network views update immediately
  if (matchId) {
    await admin
      .from('matches')
      .update({
        status: 'removed',
        removed_at: new Date().toISOString(),
        removed_by: user.id
      })
      .eq('id', matchId)
  } else {
    // No match id supplied — look one up and mark it removed if present
    await admin
      .from('matches')
      .update({
        status: 'removed',
        removed_at: new Date().toISOString(),
        removed_by: user.id
      })
      .or(buildBidirectionalMatchFilter(user.id, targetUserId))
  }

  return NextResponse.json({ success: true })
}
