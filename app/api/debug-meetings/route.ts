import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { data: meetings, error: mErr } = await supabase
    .from('meetings')
    .select('id, requester_id, recipient_id, purpose, status')
    .or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`)

  const { data: profiles, error: pErr } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in('id', [
      ...(meetings || []).map((m: any) => m.requester_id),
      ...(meetings || []).map((m: any) => m.recipient_id),
    ].filter(Boolean))

  return NextResponse.json({
    userId: user.id,
    meetingsErr: mErr?.message ?? null,
    meetings,
    profilesErr: pErr?.message ?? null,
    profiles,
  })
}
