import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertSameOrigin } from '@/lib/http/sameOrigin'

/**
 * Create the minimum incomplete profile row for an authenticated invited member who has none.
 *
 * WHY THIS EXISTS. Production holds 118 auth users with no profiles row. Onboarding writes progress
 * to profiles.onboarding_step, so those people had nowhere to save to — the step endpoint used to
 * report {success:true} while writing nothing. Returning 409 made that truthful; this preserves the
 * progress.
 *
 * ─── AUTHORIZATION ORDER IS THE SECURITY PROPERTY ─────────────────────────────────────────────
 * An earlier version returned idempotent success as soon as a profiles row existed — BEFORE it
 * checked the invitation. That let anyone holding a session with an incomplete profile skip the
 * invitation-state checks entirely, including someone whose invitation had been revoked. Existence
 * of a row is not authorization; it is the thing being authorized.
 *
 * Authorization is now fully established BEFORE the profile is even looked at:
 *   1. verified session
 *   2. exact identity resolved via lookup_auth_identity()
 *   3. resolved uuid must equal the session uuid
 *   4. invitation state resolved via lookup_waitlist_identity() — the SAME normalization contract
 *   5. exactly one 'invited' row, and no conflicting rows
 *   6. only then: inspect or create the profile
 *
 * ─── NO ILIKE ────────────────────────────────────────────────────────────────────────────────
 * The previous version matched the waitlist with ILIKE, which is a pattern match, not the
 * normalization every other path uses: `%` and `_` are wildcards and whitespace is compared rather
 * than trimmed. Two different notions of "same address" inside one authorization decision is a
 * seam, so both lookups now go through service-role resolvers that share one contract and emit no
 * address.
 *
 * ─── WHY AN INCOMPLETE PROFILE ROW IS SAFE ────────────────────────────────────────────────────
 * It is the established pattern — lib/provisioning.ts already inserts profiles with
 * profile_complete:false. Migration 061's CHECK is `profile_complete IS NOT TRUE OR (location ...)`,
 * so a NULL location is permitted; matching filters `.eq('profile_complete', true)`; and migration
 * 079 makes completeness a DIRECT predicate in can_discover_profile(), so an incomplete profile is
 * undiscoverable even where historical match/intro rows already exist.
 *
 * ─── WHY NOT provisionMemberRecords() ─────────────────────────────────────────────────────────
 * It also sets password_reset_required:true, which the dashboard gate reads as "must set a
 * password" and would bounce a member who already set one straight to the reset screen; and it
 * grants credits, a membership-level side effect that should not follow from opening a form.
 */
export async function POST(req: Request) {
  const crossOrigin = assertSameOrigin(req as any)
  if (crossOrigin) return crossOrigin

  // ── 1. Verified session. Nothing is accepted from the client — no id, no email, no waitlist id.
  const supa = createClient()
  const { data: { user } } = await supa.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let admin: ReturnType<typeof createAdminClient>
  try { admin = createAdminClient() } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }

  const email = user.email
  const denied = () => NextResponse.json({ ok: false, error: 'not_eligible' }, { status: 403 })
  const unavailable = () => NextResponse.json({ error: 'unavailable' }, { status: 503 })

  // ── 2/3. Exact identity, and it must BE this session. A resolver failure is fail-closed: acting
  //         on an identity we could not establish is how the wrong row gets created.
  const { data: idRows, error: idErr } = await admin.rpc('lookup_auth_identity', { p_email: email })
  if (idErr) return unavailable()
  const id = Array.isArray(idRows) ? idRows[0] : idRows
  if (!id) return unavailable()
  if ((id.identity_count ?? 0) !== 1 || !id.auth_user_id) return denied()   // ambiguous or absent
  if (id.auth_user_id !== user.id) return denied()                          // identity replaced

  // ── 4/5. Invitation state, same normalization contract. Exactly one 'invited' row and nothing
  //         conflicting: an address that also carries a revoked, declined or unknown-status row is
  //         refused rather than resolved in favour of the permissive one.
  const { data: wlRows, error: wlErr } = await admin.rpc('lookup_waitlist_identity', { p_email: email })
  if (wlErr) return unavailable()
  const wl = Array.isArray(wlRows) ? wlRows[0] : wlRows
  if (!wl) return unavailable()
  if ((wl.invited_count ?? 0) !== 1 || !wl.invited_id) return denied()
  if (wl.has_revoked || wl.has_declined || wl.has_other_status) return denied()
  if ((wl.total_rows ?? 0) !== 1) return denied()                           // duplicate rows

  // ── 6. Authorization is settled. Only now does the profile matter.
  const { data: existing, error: exErr } = await admin
    .from('profiles').select('id, profile_complete').eq('id', user.id).maybeSingle()
  if (exErr) return unavailable()

  if (existing) {
    // 7/8. Complete → nothing to do, and the caller can route to the dashboard.
    //      Incomplete + a valid active invitation (proven above) → idempotent resume.
    return NextResponse.json({
      ok: true, created: false, profileComplete: existing.profile_complete === true,
    })
  }

  // ── 10. Missing profile + valid invitation → create the minimal incomplete row.
  //
  // service_role insert. The browser cannot write profiles at all (migration 055 revoked INSERT and
  // UPDATE from authenticated) and this deliberately does not reintroduce that.
  //
  // location is left NULL: 061 permits it while profile_complete is not true, and inventing a
  // placeholder is exactly the "Remote"-as-a-place problem 061 exists to prevent.
  const { data: created, error: insErr } = await admin.from('profiles').insert({
    id: user.id,
    email: String(email).trim().toLowerCase(),
    profile_complete: false,      // EXPLICIT. Never rely on a column default for a safety property.
    onboarding_step: 0,
    email_verified: true,
    account_status: 'active',
  }).select('id').maybeSingle()

  if (insErr) {
    // 23505 = a concurrent request won the race. That is success: the row exists and exactly one
    // was created. Two simultaneous initializations must never produce two rows, an error the
    // member sees, or a second set of side effects.
    if ((insErr as { code?: string }).code === '23505') {
      return NextResponse.json({ ok: true, created: false, profileComplete: false })
    }
    console.error(JSON.stringify({ event: 'profile_initialize_failed', code: (insErr as { code?: string }).code ?? 'unknown' }))
    return unavailable()
  }
  if (!created?.id) return unavailable()

  return NextResponse.json({ ok: true, created: true, profileComplete: false })
}
