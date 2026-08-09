import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const MAX_IDS = 50

/**
 * GET /api/presence/label?ids=<uuid,uuid,...> — coarse presence labels for the given members.
 *
 * Gated entirely by the SECURITY DEFINER member_presence_labels RPC (auth + discoverability +
 * the member's opt-out, all enforced in SQL). Returns ONLY { labels: { [id]: label|null } } —
 * a coarse relative label, NEVER a raw timestamp. Used by the expanded Network modal to
 * refresh presence live while it is open. Fails silently to an empty map; logs a PRIVACY-SAFE
 * diagnostic (error code/message only — no emails, no member ids, no browsing activity).
 */
export async function GET(request: Request) {
  try {
    const ids = (new URL(request.url).searchParams.get('ids') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_IDS)
    if (ids.length === 0) return NextResponse.json({ labels: {} })

    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ labels: {} })

    const { data, error } = await supabase.rpc('member_presence_labels', { target_ids: ids })
    if (error) {
      console.error('[presence.label] rpc failed', { code: error.code, msg: error.message })
      return NextResponse.json({ labels: {} })
    }
    const labels: Record<string, string | null> = {}
    for (const row of (data as any[]) || []) labels[row.member_id] = row.label
    return NextResponse.json({ labels })
  } catch (e: any) {
    console.error('[presence.label] unexpected', { msg: e?.message })
    return NextResponse.json({ labels: {} })
  }
}
