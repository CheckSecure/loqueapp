import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/requireAdmin'
import { assertSameOrigin } from '@/lib/http/sameOrigin'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendSecureInviteEmail } from '@/lib/email'
import { normalizeEmail, lookupAuthUsersByEmail } from '@/lib/invitations'
import { claimInviteDelivery, markDeliveryAccepted, markDeliveryFailed } from '@/lib/invitations/delivery'
import { changeInviteEmail, type ChangeEmailDeps, type ChangeEmailState } from '@/lib/invitations/changeInviteEmail'
import { canSendInvitation, invitationsMode, INVITATIONS_PAUSED_MESSAGE, INVITATION_TEST_BLOCKED_MESSAGE } from '@/lib/invitations/featureGate'
import { getSiteUrl, getRecoveryRedirectUrl } from '@/lib/config/siteUrl'

/**
 * Admin-only: replace an INVITED, never-activated waitlist person's email and send a NEW secure
 * access link to the replacement address. Narrowly scoped — a single waitlist id + a single email;
 * NO cohort/array/bulk/wildcard capability exists. It never creates an auth user/profile/waitlist
 * row, never changes referral/answers/approval/member data, never rewrites the old delivery record,
 * and never emails a password. The compensated saga (Auth email → guarded waitlist update → verify →
 * send) lives in lib/invitations/changeInviteEmail; this route only authorizes, validates, gates,
 * wires service-role deps, and returns a coarse state (no email/id/token/link/raw error is exposed).
 */

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: any, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })
const bad = (message: string) => json({ success: false, state: 'error', error: message }, 400)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Escape SQL-LIKE wildcards so an `ilike` filter is a LITERAL case-insensitive equality (never a
// pattern). PostgreSQL LIKE/ILIKE treats `%` and `_` as wildcards with a default `\` escape char.
const likeLiteral = (s: string) => s.replace(/([\\%_])/g, '\\$1')

// state → HTTP status. Everything else defaults per branch below.
const STATUS_FOR: Partial<Record<ChangeEmailState, number>> = {
  changed_and_sent: 200,
  already_current: 200,
  changed_send_uncertain: 202,
  changed_send_failed: 200, // identity changed; the admin retries only the link
  conflict: 409,
  already_activated: 409,
  ambiguous: 409,
  pending: 200,
  needs_review: 409,
  unavailable: 503,
  critical: 500,
  error: 400,
}

export async function POST(req: Request) {
  // 0. CSRF: reject cross-origin cookie-authed mutations using standard headers only.
  const crossOrigin = assertSameOrigin(req)
  if (crossOrigin) return crossOrigin

  // 1. Authorize the admin FIRST — before ANY service-role client or production read.
  const { error } = await requireAdmin()
  if (error) return error

  // Reject anything that isn't a JSON API call (blocks form-post / simple-request CSRF).
  const ctype = req.headers.get('content-type') ?? ''
  if (!ctype.toLowerCase().includes('application/json')) return bad('Content-Type must be application/json')

  // 2. Strict body: EXACTLY { waitlistId, newEmail }. Reject arrays/extra keys/wildcards/bulk shapes.
  let body: any
  try { body = await req.json() } catch { return bad('Invalid JSON body') }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return bad('Body must be an object { waitlistId, newEmail }')
  const keys = Object.keys(body)
  if (keys.length !== 2 || !keys.includes('waitlistId') || !keys.includes('newEmail')) {
    return bad('Body must contain exactly two fields: waitlistId and newEmail')
  }
  const { waitlistId, newEmail } = body
  if (typeof waitlistId !== 'string' || !UUID_RE.test(waitlistId.trim())) return bad('waitlistId must be a valid UUID')
  if (typeof newEmail !== 'string') return bad('newEmail must be a single email string')
  const targetEmail = normalizeEmail(newEmail)
  if (!targetEmail) return bad('newEmail must be a valid email')

  // 3. ROLLOUT-MODE GATE (default off) — runs BEFORE any Auth lookup/mutation, claim, or send. When
  //    paused/not-allowlisted, NOTHING is changed or sent. Never falls back to a password flow.
  if (!canSendInvitation(targetEmail)) {
    if (invitationsMode() === 'off') {
      return json({ success: false, state: 'paused', message: INVITATIONS_PAUSED_MESSAGE }, 503)
    }
    return json({ success: false, state: 'not_allowlisted', message: INVITATION_TEST_BLOCKED_MESSAGE }, 403)
  }

  const admin = createAdminClient()

  const deps: ChangeEmailDeps = {
    siteUrl: getSiteUrl(),
    loadWaitlist: async (id) => {
      const { data } = await admin.from('waitlist').select('id, email, status, full_name').eq('id', id).maybeSingle()
      return data ? { id: data.id, email: data.email ?? null, status: data.status, fullName: data.full_name ?? null } : null
    },
    lookupAuth: (e) => lookupAuthUsersByEmail(admin, e),
    hasProfile: async (uid) => {
      const { data } = await admin.from('profiles').select('id').eq('id', uid).maybeSingle()
      return !!data
    },
    profileExistsForEmail: async (e) => {
      const { data } = await admin.from('profiles').select('id').ilike('email', likeLiteral(e)).limit(1).maybeSingle()
      return !!data
    },
    waitlistEmailConflict: async (e, excludeId) => {
      const { data } = await admin.from('waitlist').select('id').ilike('email', likeLiteral(e)).neq('id', excludeId).limit(1).maybeSingle()
      return !!data
    },
    claimDelivery: (authUserId, recipientEmail) =>
      claimInviteDelivery(admin, { waitlistId: waitlistId.trim(), authUserId, email: recipientEmail, purpose: 'access_resend' }),
    updateAuthEmail: async (userId, email) => {
      // Admin-verified change: set the new email confirmed so Supabase sends NO confirmation email of
      // its own (we deliver our own secure link) and the recovery link is immediately usable.
      const { error: e } = await admin.auth.admin.updateUserById(userId, { email, email_confirm: true } as any)
      if (e) console.error('[invite-email-change] auth update error (class):', (e as any)?.name ?? 'error')
      return !e
    },
    updateWaitlistEmailGuarded: async ({ waitlistId: id, oldEmail, newEmail: next }) => {
      // Atomic guard: only flips the row if it is STILL (this id, that old email, invited).
      const { data, error: e } = await admin.from('waitlist')
        .update({ email: next })
        .eq('id', id).eq('status', 'invited').ilike('email', likeLiteral(oldEmail))
        .select('id')
      if (e) return { rows: 0, uniqueViolation: (e as any)?.code === '23505', error: true }
      return { rows: data?.length ?? 0 }
    },
    readAuthEmail: async (userId) => {
      const { data } = await admin.auth.admin.getUserById(userId)
      return (data as any)?.user?.email ?? null
    },
    readWaitlist: async (id) => {
      const { data } = await admin.from('waitlist').select('email, status').eq('id', id).maybeSingle()
      return data ? { email: data.email ?? null, status: data.status } : null
    },
    generateLink: async (e) => {
      const options: any = { redirectTo: getRecoveryRedirectUrl() } // recovery link: never sets user_metadata
      const { data, error: ge } = await admin.auth.admin.generateLink({ type: 'recovery', email: e, options } as any)
      const hashedToken = (data as any)?.properties?.hashed_token
      if (ge || !hashedToken) throw new Error('generateLink failed')
      return { hashedToken, userId: (data as any)?.user?.id ?? null }
    },
    // Anonymous secure-link copy (no referrer naming for an admin-initiated email change).
    // ACCOUNT RECOVERY, not an invitation: this link is generateLink({type:'recovery'}) for a
    // member whose address an admin just corrected. Marked so it carries no unsubscribe headers
    // and is never blocked by a suppression — losing access to your account is not opt-out mail.
    sendEmail: (a) => sendSecureInviteEmail({ to: a.to, toName: a.toName, link: a.link, referrerName: null, purpose: 'account_recovery', idempotencyKey: a.idempotencyKey }),
    markAccepted: (id, msgId, authUserId) => markDeliveryAccepted(admin, id, msgId, authUserId),
    markFailed: (id, errClass) => markDeliveryFailed(admin, id, errClass),
    // Privacy-safe: event + coarse fields ONLY (never an email/id/token/link/raw provider error).
    log: (event, fields) => console.log('[invite-email-change]', JSON.stringify({ event, ...(fields ?? {}) })),
  }

  const result = await changeInviteEmail(deps, { waitlistId: waitlistId.trim(), newEmail: targetEmail })

  // Response carries ONLY a coarse state + safe message — no email/id/token/link.
  const status = STATUS_FOR[result.state] ?? (result.ok ? 200 : 500)
  return json({ success: result.ok, state: result.state, changed: result.changed, sent: result.sent, message: result.message }, status)
}

// POST-only: any other method (incl. GET navigation/prefetch) is a 405, never processed.
export async function GET() {
  return json({ error: 'Method not allowed' }, 405)
}
