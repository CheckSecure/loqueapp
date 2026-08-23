import { NextResponse } from 'next/server'
import { openDeletion, recordDeletionEvent } from '@/lib/account/deletionLedger'
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

  // ── Auth account lookup (for cleanup) ─────────────────────────────────────
  let authUser: any = null
  if (email) {
    try {
      authUser = await findAuthUserByEmail(admin, email)
    } catch (e: any) {
      console.error('[waitlist/revoke] auth lookup failed:', e?.message)
      return NextResponse.json({ ok: false, error: 'Could not verify the account. Please try again.' }, { status: 500 })
    }
  }

  // ── Canonical member check (server-authoritative) ─────────────────────────
  // The ONLY thing that blocks revocation is being a FULLY ACTIVE member — the
  // exact signal the Invited tab uses to exclude someone: a profile with
  // profile_complete = true (matched by email; waitlist.email == profiles.email by
  // construction — see lib/waitlist/joined.ts + app/dashboard/admin/waitlist/page.tsx).
  // A sign-in alone, or a PARTIAL profile (profile_complete = false, onboarding not
  // finished), is NOT full activation and stays revocable — exactly as it stays
  // listed under Invited. We deliberately do NOT use last_sign_in_at or mere profile
  // existence.
  const memberBlocked = 'This invitation has already been activated. Activated members must be managed from the Members section.'
  const { data: profile, error: profErr } = await admin
    .from('profiles')
    .select('id, profile_complete')
    .ilike('email', email)
    .maybeSingle()
  if (profErr) {
    console.error('[waitlist/revoke] profile lookup failed:', profErr.message)
    return NextResponse.json({ ok: false, error: 'Could not verify the account. Please try again.' }, { status: 500 })
  }
  if (profile?.profile_complete === true) {
    return NextResponse.json({ ok: false, activated: true, error: memberBlocked }, { status: 409 })
  }

  // ── Revoke ────────────────────────────────────────────────────────────────
  const now = new Date().toISOString()

  // ── Ledger: record the intent BEFORE anything is destroyed ────────────────
  // Only when this revoke will actually DESTROY something. A revoke with no partial profile and no
  // auth user only changes a waitlist status; that is not a deletion and must not be logged as one.
  //
  // FAIL CLOSED. If the record cannot be written we refuse the revoke outright rather than delete an
  // account that nothing will remember. A member disappeared once with no trace of who removed them
  // or how; the trade — an admin sees a retryable error instead of an untraceable deletion — is the
  // right way round.
  // deletion_id IS the account's UUID, not a fresh random one. The BEFORE DELETE triggers on
  // public.profiles and auth.users (migration 075) key their events the same way, so the events
  // this route writes and the events the database writes CONVERGE on one lifecycle rather than
  // producing two unrelated half-records for the same deletion.
  const deletionId = authUser?.id ?? profile?.id ?? null
  if (deletionId) {
    const opened = await openDeletion(admin, deletionId, {
      actor: 'admin',
      path: 'admin_invite_revoke',
      deletedUserId: authUser?.id ?? profile?.id ?? null,
      reason: 'invitation_revoked',
    })
    if (!opened) {
      return NextResponse.json(
        { ok: false, error: 'Could not revoke the invitation. Please try again.' },
        { status: 500 },
      )
    }
  }

  // 1) Clean up a PARTIAL profile (onboarding started, not finished) so no orphaned
  //    onboarding data remains — the delete is CONDITIONAL on profile_complete = false,
  //    which doubles as the race guard: if onboarding completes between the check
  //    above and here, the delete matches 0 rows; we re-verify, and a now-complete
  //    profile means this is a real member, so we ABORT before revoking. A profile
  //    that vanished concurrently, or a delete error (the auth-user delete below
  //    cascades the profile anyway), is non-fatal and we continue.
  if (profile) {
    const { data: deletedProfile, error: delProfErr } = await admin
      .from('profiles')
      .delete()
      .eq('id', profile.id)
      .eq('profile_complete', false)
      .select('id')
    if (delProfErr) {
      console.error('[waitlist/revoke] partial-profile delete failed (non-fatal; auth delete cascades):', delProfErr.message)
    } else if (!deletedProfile?.length) {
      const { data: recheck } = await admin
        .from('profiles').select('profile_complete').eq('id', profile.id).maybeSingle()
      if (recheck?.profile_complete === true) {
        return NextResponse.json({ ok: false, activated: true, error: memberBlocked }, { status: 409 })
      }
    }
  }

  // 2) Terminal waitlist status (removes from Invited tab + all email paths).
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

  if (deletionId) {
    // Application-side removal is done. Best-effort: the rows are already gone and this cannot
    // un-delete them, so a write failure is logged (inside the helper) and does not block.
    await recordDeletionEvent(admin, {
      deletionId, stage: 'data_deleted', actor: 'admin', path: 'admin_invite_revoke',
      deletedUserId: authUser?.id ?? profile?.id ?? null, reason: 'invitation_revoked',
    })
  }

  // 3) Delete the auth account so the temp password can no longer sign in (and to
  //    cascade-clean any residual profile). Safe: no fully-active member reaches
  //    here. Best-effort + idempotent — a missing / already-deleted user is success.
  if (authUser) {
    const { error: delErr } = await admin.auth.admin.deleteUser(authUser.id)
    const missing = delErr ? /not[\s_-]?found/i.test(delErr.message || '') : false
    if (delErr && !missing) {
      console.error('[waitlist/revoke] auth deleteUser failed (non-fatal):', delErr.message)
    }
    // This is the transition that CANNOT be atomic: deleteUser is an HTTP call to the Auth API, not
    // a statement in a database transaction. The terminal event is therefore recorded separately —
    // and its ABSENCE is the signal. A deletion_id with no 'auth_deleted' and no 'failed' means the
    // process died mid-deletion, which is a state an operator can find rather than a silent gap.
    // An already-absent user counts as deleted: the desired end state holds.
    if (deletionId) {
      await recordDeletionEvent(admin, {
        deletionId,
        stage: delErr && !missing ? 'failed' : 'auth_deleted',
        actor: 'admin', path: 'admin_invite_revoke',
        deletedUserId: authUser.id, reason: 'invitation_revoked',
        // A CLASS, never the provider's message — those routinely echo the address that caused them.
        errorClass: delErr && !missing ? 'auth_api_error' : undefined,
      })
    }
  } else if (deletionId) {
    // No auth identity existed; removing the partial profile completed the deletion.
    await recordDeletionEvent(admin, {
      deletionId, stage: 'auth_deleted', actor: 'admin', path: 'admin_invite_revoke',
      deletedUserId: profile?.id ?? null, reason: 'invitation_revoked',
    })
  }

  // 4) Sync any linked referral to terminal (mirrors the decline path). No-op if none.
  await admin.from('referrals').update({ status: 'rejected', rejected_at: now }).eq('waitlist_id', entryId)

  // Operational log line. The DURABLE record is public.account_deletion_events (migration 075);
  // this is for tailing logs, and is not the audit trail any more.
  console.log(JSON.stringify({ event: 'invite_revoked', admin_id: user.id, waitlist_id: entryId, at: now }))

  revalidatePath('/dashboard', 'layout')
  return NextResponse.json({ ok: true, success: true, state: 'revoked' })
}
