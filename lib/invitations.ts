/**
 * Shared, mostly-pure helpers for the invitation / registration idempotency fix.
 *
 * The state DECISIONS (resolveInviteAction, registrationExistingState) are pure
 * so they can be unit-tested without Supabase; the two async helpers wrap admin
 * lookups. Server-only (imports node:crypto).
 */
import { randomBytes } from 'node:crypto'
import { normalizeEmail } from '@/lib/auth/normalizeEmail'

/** Canonical email form used for every lookup, insert, and comparison. */
export { normalizeEmail }

/**
 * Unambiguous alphabet for temporary passwords: excludes the character pairs
 * that are indistinguishable when read from an email and re-typed by hand
 * (0/O, 1/l/I) and all punctuation (`-` `_` `+` `/`) that copy/paste, HTML
 * escaping, or line-wrapping can silently alter or drop. 56 symbols.
 */
const TEMP_PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'

/**
 * Cryptographically secure temporary password (20 chars, ~116 bits). Uses only
 * TEMP_PW_ALPHABET so a member can reliably read it from the invite email and
 * type it into the login form — the previous base64url form could contain
 * `0/O/1/l/I/-/_`, a recurring source of "the password doesn't work" reports.
 */
export function generateTempPassword(length = 20): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += TEMP_PW_ALPHABET[bytes[i] % TEMP_PW_ALPHABET.length]
  return out
}

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
