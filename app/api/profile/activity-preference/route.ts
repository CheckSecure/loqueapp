import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertSameOrigin } from '@/lib/http/sameOrigin'

export const dynamic = 'force-dynamic'

/**
 * POST /api/profile/activity-preference  { show_activity_status: boolean }
 * The member's "Show when I'm active" opt-out. Same-origin, authenticated, scoped to the caller's own
 * row (never an arbitrary id); only the show_activity_status column is written. The write runs as
 * service_role — browser UPDATE on profiles is revoked (migration 055).
 */
export async function POST(req: Request) {
  const crossOrigin = assertSameOrigin(req)
  if (crossOrigin) return crossOrigin

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  if (typeof body?.show_activity_status !== 'boolean') {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  const { data, error } = await createAdminClient()
    .from('profiles')
    .update({ show_activity_status: body.show_activity_status, updated_at: new Date().toISOString() })
    .eq('id', user.id)
    .select('show_activity_status')
    .single()

  if (error) return NextResponse.json({ error: 'Could not save your preference.' }, { status: 500 })
  return NextResponse.json({ ok: true, show_activity_status: data.show_activity_status })
}
