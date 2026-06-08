import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendLaunchAnnouncementEmail } from '@/lib/email'

export const runtime = 'nodejs'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

// Test-send: fires a single launch-announcement email to the operator's own
// inbox so the rendered HTML can be eyeballed before the bulk send is
// triggered. Deliberately does NOT touch the waitlist table — no
// launch_announcement_sent_at update, no error column write. Test sends are
// exempt from the per-row idempotency check so the operator can re-fire as
// many times as needed during copy review.
export async function POST() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await sendLaunchAnnouncementEmail(
    user.email!,
    user.user_metadata?.full_name || 'Daniel',
  )

  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
