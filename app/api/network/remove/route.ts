import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { matchId } = await req.json().catch(() => ({}))
  if (!matchId) return NextResponse.json({ error: 'matchId required' }, { status: 400 })

  const admin = createAdminClient()

  const { data: match, error: matchErr } = await admin
    .from('matches')
    .select('id, user_a_id, user_b_id, status, removed_at')
    .eq('id', matchId)
    .maybeSingle()

  if (matchErr || !match) {
    return NextResponse.json({ error: 'Match not found' }, { status: 404 })
  }
  if (match.user_a_id !== user.id && match.user_b_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Idempotent: if already removed, just return success
  if (match.status === 'removed' && match.removed_at) {
    return NextResponse.json({ success: true, alreadyRemoved: true })
  }

  const { error: updErr } = await admin
    .from('matches')
    .update({
      status: 'removed',
      removed_at: new Date().toISOString(),
      removed_by: user.id
    })
    .eq('id', matchId)

  if (updErr) {
    console.error('[network/remove] update error:', updErr)
    return NextResponse.json({ error: 'Failed to remove connection' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
