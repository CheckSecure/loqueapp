import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeEmail } from '@/lib/email/unsubscribe'

const VALID_COLUMNS = new Set([
  'email_new_introductions',
  'email_messages',
  'email_meeting_updates',
  'email_opportunities',
  'email_product_updates',
  'email_daily_digest',
])

export async function PATCH(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const updates: Record<string, boolean> = {}
  for (const [key, val] of Object.entries(body)) {
    if (!VALID_COLUMNS.has(key) || typeof val !== 'boolean') {
      return NextResponse.json({ error: `Invalid field: ${key}` }, { status: 400 })
    }
    updates[key] = val
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields provided' }, { status: 400 })
  }

  const { error } = await supabase
    .from('notification_preferences')
    .upsert({ user_id: user.id, ...updates, updated_at: new Date().toISOString() })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // RE-SUBSCRIBE. A one-click unsubscribe writes an email-keyed row in email_suppressions (091),
  // which isPrefEnabled consults BEFORE these columns. Turning a category back on here therefore
  // has to clear that row too — otherwise the member sees the toggle switch to "on" while mail
  // stays silently suppressed, with no surface anywhere to undo it.
  //
  // service_role because email_suppressions has no browser-role privileges by design; the session
  // check above is what authorizes it, and the delete is pinned to this user's own address.
  const reEnabled = Object.entries(updates).filter(([, on]) => on).map(([k]) => k)
  if (reEnabled.length > 0 && user.email) {
    const { error: unsuppressError } = await createAdminClient()
      .from('email_suppressions')
      .delete()
      .eq('email', normalizeEmail(user.email))
      // 'all' is included: an explicit unsubscribe-from-everything must not outlive the member
      // deliberately turning a category back on.
      .in('category', [...reEnabled, 'all'])
    // Logged, not fatal: the preference itself saved, and a stale suppression is recoverable.
    if (unsuppressError) console.error('[notification-preferences] unsuppress failed:', unsuppressError)
  }

  return NextResponse.json({ success: true })
}
