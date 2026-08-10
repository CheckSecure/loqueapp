/**
 * Shared, mostly-pure helpers for the invitation / registration idempotency fix.
 *
 * The state DECISIONS (resolveInviteAction, registrationExistingState) are pure
 * so they can be unit-tested without Supabase; the two async helpers wrap admin
 * lookups. Server-only (imports node:crypto).
 */
import { normalizeEmail } from '@/lib/auth/normalizeEmail'

/** Canonical email form used for every lookup, insert, and comparison. */
export { normalizeEmail }

// NOTE: temporary-password generation was removed — invitations are now passwordless
// (secure set-password links only). See lib/invitations/secureInvite.ts.

/**
 * Find an auth user by email, case-insensitively. Supabase admin has no
 * get-by-email, so we page through listUsers (fine for the current user base).
 * Returns the user object or null. Throws only on a hard listUsers error.
 */
export async function findAuthUserByEmail(admin: any, email: string): Promise<any | null> {
  const target = normalizeEmail(email)
  if (!target) return null
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw error
    const hit = (data?.users ?? []).find((u: any) => normalizeEmail(u.email) === target)
    if (hit) return hit
    if (!data?.users?.length || data.users.length < 1000) return null
  }
}

/**
 * COUNT the auth users at a normalized email (to detect duplicate/ambiguous identities) and
 * return the first match. `count > 1` is a hard-stop for the secure-invite flow. Throws only
 * on a hard listUsers error.
 */
export async function lookupAuthUsersByEmail(
  admin: any,
  email: string,
): Promise<{ count: number; user: { id: string; last_sign_in_at: string | null } | null }> {
  const target = normalizeEmail(email)
  if (!target) return { count: 0, user: null }
  const matches: any[] = []
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw error
    for (const u of data?.users ?? []) if (normalizeEmail(u.email) === target) matches.push(u)
    if (!data?.users?.length || data.users.length < 1000) break
  }
  const first = matches[0]
  return { count: matches.length, user: first ? { id: first.id, last_sign_in_at: first.last_sign_in_at ?? null } : null }
}

export type InvitePlan = 'create' | 'reset' | 'active' | 'password_reset'
export type InviteAction = 'invite' | 'password_reset'

export interface InviteDecision {
  plan: InvitePlan
  state: 'invited' | 'resent' | 'active' | 'password_reset_sent'
  message?: string
}

/**
 * Decide what the send-invite route should do, from the member's auth state.
 *   action 'password_reset' (explicit admin action) → always reset + email.
 *   action 'invite' (Send Invite / Resend):
 *     no auth user            → create (first invite)
 *     auth exists, activated  → do NOTHING (return 'active'); admin must use the
 *                               explicit password-reset action instead.
 *     auth exists, not active → reset the temp password + resend (no createUser)
 * `activated` = has signed in OR has a profile row.
 */
export function resolveInviteAction(args: {
  authExists: boolean
  activated: boolean
  action: InviteAction
}): InviteDecision {
  if (args.action === 'password_reset') {
    return { plan: 'password_reset', state: 'password_reset_sent' }
  }
  if (!args.authExists) return { plan: 'create', state: 'invited' }
  if (args.activated) {
    return { plan: 'active', state: 'active', message: 'This member already has an active account.' }
  }
  return { plan: 'reset', state: 'resent' }
}

/**
 * Registration re-entry guard. If a waitlist row, profile, or auth user already
 * exists for the email, block a new waitlist submission with ONE generic message
 * (no per-state detail → avoids account enumeration).
 */
export function registrationExistingState(args: {
  waitlistExists: boolean
  profileExists: boolean
  authExists: boolean
}): { blocked: boolean; message: string } {
  const exists = args.waitlistExists || args.profileExists || args.authExists
  return exists
    ? { blocked: true, message: 'You already have an Andrel account or invitation.' }
    : { blocked: false, message: '' }
}
