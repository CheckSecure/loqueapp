import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/requireAdmin'
import { createAdminClient } from '@/lib/supabase/admin'

export async function POST(req: Request) {
  const { error, user } = await requireAdmin()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const matchId = typeof body.matchId === 'string' ? body.matchId : ''
  if (!matchId) return NextResponse.json({ error: 'matchId required' }, { status: 400 })

  const admin = createAdminClient()

  const { data: match, error: fetchErr } = await admin
    .from('matches')
    .select('id, status, removed_at')
    .eq('id', matchId)
    .maybeSingle()

  if (fetchErr || !match) return NextResponse.json({ error: 'Match not found' }, { status: 404 })
  if (match.status !== 'removed') {
    return NextResponse.json({ error: 'Match is not in removed state (current: ' + match.status + ')' }, { status: 409 })
  }

  const { error: updErr } = await admin
    .from('matches')
    .update({ status: 'active', removed_at: null, removed_by: null, admin_notes: 'manual_restore' })
    .eq('id', matchId)

  if (updErr) {
    console.error('[admin/restore-match] error:', updErr)
    return NextResponse.json({ error: 'Failed to restore match' }, { status: 500 })
  }

  console.log('[admin/restore-match]', { by: user?.email, matchId })
  return NextResponse.json({ success: true })
}
