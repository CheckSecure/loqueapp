import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

/**
 * POST /api/profile/heartbeat — lightweight presence ping while a tab is open.
 *
 * The member is identified ONLY from the server-side session — an arbitrary member id is
 * never accepted from the client. Writes go to the PRIVATE member_presence table, whose
 * self-only RLS lets a member touch just their own row (no other member can read it).
 * Throttled server-side (writes at most ~once/5 min per member) so repeated pings /
 * re-focus events don't cause excess writes. Records ONLY last_active_at — no URL, history,
 * IP, or device data, and no activity log. Fails SILENTLY (always 200) so it can never
 * block navigation or break the UI.
 */
const THROTTLE_MS = 5 * 60 * 1000

export async function POST() {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ ok: false })
    const { data: prof } = await supabase.from('member_presence').select('last_active_at').eq('user_id', user.id).maybeSingle()
    const last = prof?.last_active_at ? new Date(prof.last_active_at).getTime() : 0
    if (Date.now() - last >= THROTTLE_MS) {
      const now = new Date().toISOString()
      await supabase.from('member_presence').upsert({ user_id: user.id, last_active_at: now, updated_at: now }, { onConflict: 'user_id' })
    }
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: true }) // never surface an error to the client
  }
}
