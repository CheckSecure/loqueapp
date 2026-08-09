import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

/**
 * POST /api/profile/heartbeat — lightweight presence ping while a tab is open.
 *
 * The member is identified ONLY from the server-side session — an arbitrary member id is
 * never accepted from the client. Writes go to the PRIVATE member_presence table, whose
 * self-only RLS lets a member touch just their own row (no other member can read it).
 * Records ONLY last_active_at — no URL, history, IP, or device data, and no activity log.
 *
 * THROTTLE: write at most once per 3 min per member. The client pings ~once/min, so the
 * worst-case staleness before the next write is ≈ 3 + 1 = 4 min, comfortably inside the
 * 5-minute "Online now" window. (The previous 5-min server throttle beating against a
 * 4.5-min client cadence let last_active_at drift to ~9 min and drop "Online now".)
 *
 * OBSERVABILITY: the response is always 200 so a failure never blocks navigation, but the
 * exact failing layer (auth / read / upsert) is now logged PRIVACY-SAFELY — error code +
 * message + the member's uuid only. No email address, request URL, IP address, device
 * header, or browsing activity is ever logged. This makes a heartbeat failure diagnosable
 * instead of invisible.
 */
const THROTTLE_MS = 3 * 60 * 1000

export async function POST() {
  try {
    const supabase = createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      if (authError) console.warn('[presence.heartbeat] auth failed', { code: (authError as any)?.status ?? authError.name })
      return NextResponse.json({ ok: false })
    }
    const { data: prof, error: readError } = await supabase
      .from('member_presence')
      .select('last_active_at')
      .eq('user_id', user.id)
      .maybeSingle()
    if (readError) console.error('[presence.heartbeat] read failed', { uid: user.id, code: readError.code, msg: readError.message })
    const last = prof?.last_active_at ? new Date(prof.last_active_at).getTime() : 0
    if (Date.now() - last >= THROTTLE_MS) {
      const now = new Date().toISOString()
      const { error: writeError } = await supabase
        .from('member_presence')
        .upsert({ user_id: user.id, last_active_at: now, updated_at: now }, { onConflict: 'user_id' })
      if (writeError) {
        // The exact failing layer surfaces HERE instead of being hidden by the 200.
        console.error('[presence.heartbeat] upsert failed', { uid: user.id, code: writeError.code, msg: writeError.message })
      }
    }
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('[presence.heartbeat] unexpected', { msg: e?.message })
    return NextResponse.json({ ok: true }) // never surface an error to the client / block navigation
  }
}
