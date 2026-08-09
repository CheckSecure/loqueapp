import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { isBlockedTransition } from '@/lib/referrals/statusTransitions'
import { isMissingColumnError } from '@/lib/db/isMissingColumn'

const ADMIN_EMAIL = 'bizdev91@gmail.com'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Admin-only: REINSTATE an accidentally-declined waitlist row back to the Invited tab.
 *
 * A guarded, atomic transition declined → invited on the IMMUTABLE row id. It sends NOTHING:
 * no invitation, no provisioning, no password reset, no email of any kind — it only flips the
 * status marker (exactly what send-invite does) so the row leaves Declined and appears under
 * Invited, where the admin may then use the explicit Send/Resend action if they choose.
 *
 * It DOES NOT touch invited_at. Leaving it as-is means a never-invited row (invited_at IS
 * NULL — the normal declined case, since invited → declined is not a valid transition) stays
 * OUT of every reminder-email cron: activation-reminders gates on status='invited' AND
 * invited_at IS NOT NULL. No auth user, profile, referral, note, source, or onboarding state
 * is created or modified — only waitlist.status changes. The existing auth account / profile
 * (if any) are preserved untouched.
 */
export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  // Server-side admin authorization — never trust the client.
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const entryId = body?.entryId
  // Target ONLY by immutable row id — never an email. Reject malformed ids.
  if (typeof entryId !== 'string' || !UUID_RE.test(entryId)) {
    return NextResponse.json({ ok: false, error: 'Missing or invalid entryId' }, { status: 400 })
  }

  const admin = createAdminClient()

  const { data: entry } = await admin.from('waitlist').select('id, status').eq('id', entryId).maybeSingle()
  if (!entry) return NextResponse.json({ ok: false, error: 'Entry not found' }, { status: 404 })

  // Only a DECLINED row may be reinstated (server-authoritative; mirrors the transition matrix).
  if (entry.status !== 'declined' || isBlockedTransition('declined', 'invited')) {
    return NextResponse.json(
      { ok: false, error: `Only a declined person can be reinstated (current status: ${entry.status}).` },
      { status: 409 },
    )
  }

  // Guarded ATOMIC transition: update exactly the one row, and only while it is STILL
  // 'declined' — so a concurrent change (double-click / another admin) loses the race and we
  // return a neutral conflict. Preserves invited_at, auth user, profile, referral, notes,
  // source, and onboarding — only `status` changes.
  const now = new Date().toISOString()
  let { data: updated, error } = await admin
    .from('waitlist')
    .update({ status: 'invited', updated_at: now })
    .eq('id', entryId)
    .eq('status', 'declined')
    .select('id, status')
  if (error && isMissingColumnError(error)) {
    // waitlist has no updated_at column → flip status only (still guarded + atomic).
    ;({ data: updated, error } = await admin
      .from('waitlist')
      .update({ status: 'invited' })
      .eq('id', entryId)
      .eq('status', 'declined')
      .select('id, status'))
  }
  if (error) {
    console.error('[waitlist/reinstate] update failed:', error.message)
    return NextResponse.json({ ok: false, error: 'Could not reinstate this person. Please try again.' }, { status: 500 })
  }
  if (!updated || updated.length === 0) {
    // Concurrent change: the row is no longer 'declined'. Neutral conflict → the UI refreshes.
    return NextResponse.json(
      { ok: false, conflict: true, error: 'This person is no longer declined. Refresh and try again.' },
      { status: 409 },
    )
  }

  // Safe audit trail — ids + statuses + actor only; no tokens, secrets, or PII.
  console.log(JSON.stringify({
    event: 'waitlist_reinstated',
    admin_id: user.id,
    waitlist_id: entryId,
    previous_status: 'declined',
    new_status: 'invited',
    at: now,
  }))

  revalidatePath('/dashboard', 'layout')
  return NextResponse.json({ ok: true, success: true, state: 'invited' })
}
