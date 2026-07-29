import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
import { revalidatePath } from 'next/cache'
import { normalizeEmail, findAuthUserByEmail } from '@/lib/invitations'
import { isBlockedTransition } from '@/lib/referrals/statusTransitions'
import { isMissingColumnError } from '@/lib/db/isMissingColumn'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

/**
 * Admin-only: revoke an invitation BEFORE the member has activated.
 *
 * The activation check is enforced HERE (never trust the UI): a member is
 * activated if their auth user has ever signed in OR a profile row exists — the
 * same canonical check the invite flow uses. An activated invitation cannot be
 * revoked. Idempotent: revoking an already-revoked (or absent-auth) invitation
 * returns success without side effects.
 *
 * Revoke = set waitlist.status = 'revoked' (terminal; excludes the row from the
 * Invited tab AND every invite/reminder email path, which all gate on
 * status='invited') + stamp revoked_at, then delete the bare (not-activated) auth
 * account so the temp password can no longer sign in. The row is preserved for
 * audit — nothing is physically deleted.
 */
export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const entryId = body?.entryId
  if (!entryId) return NextResponse.json({ error: 'Missing entryId' }, { status: 400 })

  const admin = createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: entry } = await admin
    .from('waitlist')
    .select('id, email, full_name, status')
    .eq('id', entryId)
    .maybeSingle()
  if (!entry) return NextResponse.json({ error: 'Entry not found' }, { status: 404 })

  // Idempotent: already revoked → success, no work (handles duplicate clicks /
  // network retries / a second concurrent request).
  if (entry.status === 'revoked') {
    return NextResponse.json({ ok: true, success: true, state: 'revoked', alreadyRevoked: true })
  }

  // Only an INVITED (not-yet-activated) invitation may be revoked. Blocks
  // pending/approved/contacted/declined; permissive for unknown/legacy (the
  // activation check below is the real guard).
  if (isBlockedTransition(entry.status, 'revoked')) {
    return NextResponse.json(
      { ok: false, error: `Only an invited member can be revoked (current status: ${entry.status}).` },
      { status: 409 },
    )
  }

  const email = normalizeEmail(entry.email)

  // ── Activation check (server-authoritative) ───────────────────────────────
  let authUser: any = null
  if (email) {
    try {
      authUser = await findAuthUserByEmail(admin, email)
    } catch (e: any) {
      console.error('[waitlist/revoke] auth lookup failed:', e?.message)
      return NextResponse.json({ ok: false, error: 'Could not verify the account. Please try again.' }, { status: 500 })
    }
  }

  let activated = false
  if (authUser) {
    if (authUser.last_sign_in_at) {
      activated = true
    } else {
      const { data: profileRow, error: profErr } = await admin
        .from('profiles').select('id').eq('id', authUser.id).maybeSingle()
      if (profErr) {
        console.error('[waitlist/revoke] profile lookup failed:', profErr.message)
        return NextResponse.json({ ok: false, error: 'Could not verify the account. Please try again.' }, { status: 500 })
      }
      activated = !!profileRow
    }
  }

  if (activated) {
    return NextResponse.json(
      {
        ok: false,
        activated: true,
        error: 'This invitation has already been activated. Activated members must be managed from the Members section.',
      },
      { status: 409 },
    )
  }

  // ── Revoke ────────────────────────────────────────────────────────────────
  const now = new Date().toISOString()

  // 1) Terminal waitlist status (removes from Invited tab + all email paths).
  //    Resilient to migration 029 (revoked_at) not being applied yet.
  let { error: wlErr } = await admin
    .from('waitlist')
    .update({ status: 'revoked', revoked_at: now })
    .eq('id', entryId)
  if (wlErr && isMissingColumnError(wlErr)) {
    console.warn('[waitlist/revoke] revoked_at column missing; setting status only (apply migration 029)')
    ;({ error: wlErr } = await admin.from('waitlist').update({ status: 'revoked' }).eq('id', entryId))
  }
  if (wlErr) {
    return NextResponse.json({ ok: false, error: 'Could not revoke the invitation. Please try again.' }, { status: 500 })
  }

  // 2) Delete the bare, not-activated auth account so the temp password can no
  //    longer sign in. Safe (no profile → no cascade). Best-effort + idempotent:
  //    a missing / already-deleted user is treated as success.
  if (authUser) {
    const { error: delErr } = await admin.auth.admin.deleteUser(authUser.id)
    if (delErr && !/not[\s_-]?found/i.test(delErr.message || '')) {
      console.error('[waitlist/revoke] auth deleteUser failed (non-fatal):', delErr.message)
    }
  }

  // 3) Sync any linked referral to terminal (mirrors the decline path). No-op if none.
  await admin.from('referrals').update({ status: 'rejected', rejected_at: now }).eq('waitlist_id', entryId)

  // Lightweight audit trail (no formal admin-audit table exists in the repo).
  console.log(JSON.stringify({ event: 'invite_revoked', admin_id: user.id, waitlist_id: entryId, at: now }))

  revalidatePath('/dashboard', 'layout')
  return NextResponse.json({ ok: true, success: true, state: 'revoked' })
}
