import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

/**
 * DEPRECATED & DISABLED. This legacy stub used to set waitlist.status='invited' + invited_at
 * WITHOUT sending any email — manufacturing a false "invited" state. No production UI calls it
 * (verified). It now fails safe: it authorizes the admin, then returns 410 Gone and writes
 * NOTHING. Real invitations go through POST /api/admin/send-invite (secure, passwordless,
 * delivery-tracked).
 */
export async function POST() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json(
    { error: 'This endpoint is deprecated. Use POST /api/admin/send-invite (secure invitation).', code: 'deprecated' },
    { status: 410 },
  )
}
