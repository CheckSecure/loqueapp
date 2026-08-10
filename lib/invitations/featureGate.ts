// Server-side invitation ROLLOUT MODE. Replaces the old boolean kill-switch with an explicit
// three-mode gate so a single controlled account can be tested before global enablement.
//
//   off  — DEFAULT. No invitation/access-link sends; reminders paused. (Password reset unaffected.)
//   test — Only explicitly allowlisted test recipients may receive secure invitations.
//   on   — Normal production behavior; reminders may run.
//
// Anything unset/empty/malformed/unknown parses to `off`. Enforcement is SERVER-SIDE only.
// It NEVER falls back to the old password flow.

import { normalizeEmail } from '@/lib/auth/normalizeEmail'

export type InvitationsMode = 'off' | 'test' | 'on'

/** Parse INVITATIONS_MODE. Unknown/empty/malformed → 'off' (fail safe). */
export function invitationsMode(): InvitationsMode {
  const raw = (process.env.INVITATIONS_MODE || '').trim().toLowerCase()
  if (raw === 'on') return 'on'
  if (raw === 'test') return 'test'
  return 'off'
}

/**
 * Normalized test-mode allowlist from INVITATION_TEST_EMAILS (comma-separated). Uses the SAME
 * normalization as login (`normalizeEmail`). Empty/malformed entries are dropped, so an empty or
 * malformed allowlist yields an EMPTY set → no recipients allowed. Never logged.
 */
export function invitationTestAllowlist(): Set<string> {
  const set = new Set<string>()
  for (const part of (process.env.INVITATION_TEST_EMAILS || '').split(',')) {
    const n = normalizeEmail(part)
    if (n) set.add(n)
  }
  return set
}

/**
 * May a secure invitation / access link be sent to this recipient RIGHT NOW?
 *   off  → never;  test → only if the canonical normalized address is allowlisted;  on → always.
 * The email is normalized with the login normalizer before the allowlist check.
 */
export function canSendInvitation(email: string | null | undefined): boolean {
  const mode = invitationsMode()
  if (mode === 'off') return false
  if (mode === 'on') return true
  const n = normalizeEmail(email)
  if (!n) return false
  return invitationTestAllowlist().has(n)
}

/** Activation-reminder cron runs ONLY in 'on' mode. 'test' and 'off' keep reminders fully paused. */
export function activationRemindersEnabled(): boolean {
  return invitationsMode() === 'on'
}

/** Coarse "subsystem not fully off" check (mode !== 'off'). Per-recipient sends still use canSendInvitation. */
export function invitationsEnabled(): boolean {
  return invitationsMode() !== 'off'
}

export const INVITATIONS_PAUSED_MESSAGE =
  'Secure invitations are paused (rollout mode: off). No email was sent.'

// Neutral, admin-safe message for a test-mode request to a non-allowlisted recipient. Contains
// NO email address.
export const INVITATION_TEST_BLOCKED_MESSAGE =
  'Invitation test mode is active. This recipient is not on the test allowlist, so nothing was sent.'
