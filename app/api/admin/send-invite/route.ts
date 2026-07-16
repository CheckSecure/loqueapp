import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
import { sendInviteEmail, sendReferralInviteEmail } from '@/lib/email'
import {
  normalizeEmail,
  generateTempPassword,
  findAuthUserByEmail,
  resolveInviteAction,
  type InviteAction,
} from '@/lib/invitations'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const entryId = body.entryId
  const markAsFounding = body.markAsFounding === true
  // 'invite' (Send Invite / Resend) or 'password_reset' (explicit admin action).
  const action: InviteAction = body.action === 'password_reset' ? 'password_reset' : 'invite'

  const { data: entry, error: entryErr } = await supabase
    .from('waitlist')
    .select('*')
    .eq('id', entryId)
    .single()
  if (entryErr || !entry) {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 })
  }

  const email = normalizeEmail(entry.email)
  if (!email) return NextResponse.json({ error: 'Entry has no email' }, { status: 400 })

  const admin = createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // --- Determine current auth state (case-insensitive) ---
  let authUser: any = null
  try {
    authUser = await findAuthUserByEmail(admin, email)
  } catch (e: any) {
    console.error('[send-invite] auth lookup failed:', e?.message)
    return NextResponse.json({ error: 'Could not look up the member account. Please try again.' }, { status: 500 })
  }

  let activated = false
  if (authUser) {
    if (authUser.last_sign_in_at) {
      activated = true
    } else {
      const { data: profileRow, error: profErr } = await admin
        .from('profiles').select('id').eq('id', authUser.id).maybeSingle()
      if (profErr) {
        console.error('[send-invite] profile lookup failed:', profErr.message)
        return NextResponse.json({ error: 'Could not verify the member account. Please try again.' }, { status: 500 })
      }
      activated = !!profileRow
    }
  }

  const decision = resolveInviteAction({ authExists: !!authUser, activated, action })

  // Active member + a generic Resend → never silently reset; tell the admin.
  if (decision.plan === 'active') {
    return NextResponse.json(
      { success: false, state: 'active', message: decision.message },
      { status: 200 },
    )
  }

  // --- Send the access email (shared by create/reset/password_reset) ---
  async function sendAccessEmail(tempPassword: string): Promise<{ success: boolean; error?: string }> {
    let referrerName: string | null = null
    if (entry.referral_source === 'referral') {
      const { data: referralRow } = await admin
        .from('referrals')
        .select('referrer:profiles!referrer_user_id(full_name)')
        .eq('waitlist_id', entryId)
        .maybeSingle()
      referrerName = (referralRow?.referrer as any)?.full_name ?? null
    }
    return referrerName
      ? sendReferralInviteEmail(email, entry.full_name || 'there', tempPassword, referrerName)
      : sendInviteEmail(email, entry.full_name || 'there', tempPassword)
  }

  const tempPassword = generateTempPassword()

  if (decision.plan === 'create') {
    // First invite — no auth user yet.
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: markAsFounding ? { markAsFounding: true } : undefined,
    })
    if (createErr || !created?.user) {
      console.error('[send-invite] createUser failed:', createErr?.message)
      return NextResponse.json({ error: 'Could not create the member account.' }, { status: 500 })
    }
    const emailRes = await sendAccessEmail(tempPassword)
    if (!emailRes.success) {
      return NextResponse.json({ error: `Email failed: ${emailRes.error}` }, { status: 500 })
    }
    const { error: wlErr } = await supabase
      .from('waitlist')
      .update({ status: 'invited', invited_at: new Date().toISOString() })
      .eq('id', entryId)
    if (wlErr) {
      console.error('[send-invite] waitlist update failed (invited):', wlErr.message)
      return NextResponse.json({ error: 'Invite sent but status update failed. Please refresh.' }, { status: 500 })
    }
    await admin.from('referrals').update({ status: 'invited' }).eq('waitlist_id', entryId)
    return NextResponse.json({ success: true, state: 'invited' })
  }

  // decision.plan is 'reset' (invited, not activated) or 'password_reset'
  // (explicit admin action, possibly on an active member). Either way: reset the
  // EXISTING auth user's password — never createUser, never create a profile,
  // never touch credits / founding / welcome (those are onboarding-only).
  const updatePayload: Record<string, unknown> = { password: tempPassword }
  if (markAsFounding) {
    updatePayload.user_metadata = { ...(authUser.user_metadata ?? {}), markAsFounding: true }
  }
  const { error: resetErr } = await admin.auth.admin.updateUserById(authUser.id, updatePayload)
  if (resetErr) {
    console.error('[send-invite] password reset failed:', resetErr.message)
    return NextResponse.json({ error: 'Could not reset the access password.' }, { status: 500 })
  }
  const emailRes = await sendAccessEmail(tempPassword)
  if (!emailRes.success) {
    return NextResponse.json({ error: `Email failed: ${emailRes.error}` }, { status: 500 })
  }

  // For a not-yet-activated resend, keep the row 'invited' and refresh invited_at.
  // For an explicit password reset on an active member, leave their status as-is.
  if (decision.plan === 'reset') {
    const { error: wlErr } = await supabase
      .from('waitlist')
      .update({ status: 'invited', invited_at: new Date().toISOString() })
      .eq('id', entryId)
    if (wlErr) {
      console.error('[send-invite] waitlist update failed (resent):', wlErr.message)
      return NextResponse.json({ error: 'Email resent but status update failed. Please refresh.' }, { status: 500 })
    }
    await admin.from('referrals').update({ status: 'invited' }).eq('waitlist_id', entryId)
  }

  return NextResponse.json({ success: true, state: decision.state })
}
