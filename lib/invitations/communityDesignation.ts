/**
 * lib/invitations/communityDesignation.ts — which community an invitation is FOR.
 *
 * Migration 099 put the intended community on the waitlist row (`intended_member_type`, NOT NULL
 * DEFAULT 'professional'); migration 100 binds the first profile's member_type to it at INSERT. This
 * module is the small, shared decision layer for the one place an administrator may set it: the
 * send-invite route, before the invitation is issued.
 *
 * ─── WHAT IT IS NOT ───────────────────────────────────────────────────────────────────────────
 * NOT a conversion mechanism. Nothing here can move a member between communities: it writes an
 * INVITATION's intent before that invitation exists as an account, and migration 099's BEFORE UPDATE
 * trigger makes profiles.member_type immutable regardless. A different-community reissue is an
 * explicit revoke-and-recreate workflow and is deliberately not buildable from here.
 *
 * NOT an authorization boundary. The send-invite route's existing server-side admin check is the
 * authority, and RLS independently restricts UPDATE on public.waitlist to is_admin(). This module
 * only decides WHAT a validated admin request means.
 */

export const INTENDED_MEMBER_TYPES = ['professional', 'next'] as const
export type IntendedMemberType = (typeof INTENDED_MEMBER_TYPES)[number]

/** The column default, and what every existing waitlist row already holds (migration 099). */
export const DEFAULT_INTENDED_MEMBER_TYPE: IntendedMemberType = 'professional'

/**
 * The only invitation states from which a community may be chosen.
 *
 * Deliberately POSITIVE, and deliberately not "anything before invited". waitlist.status carries no
 * CHECK constraint anywhere in migrations 001-100 — the vocabulary lives only in
 * lib/referrals/statusTransitions.ts — so a status this code has never seen must fail closed rather
 * than be waved through by an inverted test. Migration 100's provisioning authorizer tests for
 * 'invited' the same way, and for the same reason.
 *
 * (That authorizer is deliberately not named here. The Phase 4A-2 pin asserts which production
 * files reference it, and a prose mention in an unrelated module would dilute that signal.)
 */
export const DESIGNATABLE_STATUSES = ['approved', 'contacted'] as const

/**
 * Coerce a browser-supplied value to a community. NEVER passes an arbitrary value through.
 *
 * Anything that is not exactly 'next' becomes 'professional'. That direction matters: an
 * unrecognised value must land on the safe default rather than reach the database and be refused by
 * a CHECK constraint, and absence must mean Professional so that doing nothing stays Professional.
 */
export function normalizeDesignation(raw: unknown): IntendedMemberType {
  return raw === 'next' ? 'next' : 'professional'
}

/** May a community be chosen for an invitation currently in this state? */
export function canDesignateAtStatus(status: string | null | undefined): boolean {
  return (DESIGNATABLE_STATUSES as readonly string[]).includes((status ?? '').trim())
}

/**
 * Did the caller actually ask for a designation? Absent means "no opinion", which is how the
 * ordinary Professional path — and every resend — reaches the server: no field, no write, no
 * behaviour change at all.
 */
export function designationRequested(body: unknown): boolean {
  return !!body && typeof body === 'object' && 'intendedMemberType' in (body as Record<string, unknown>)
}

/**
 * The stable fragment migration 099's conflicting-intent trigger raises. That message is
 * deliberately address-free because it reaches logs; this matches its wording, not its SQLSTATE.
 *
 * Matching the SQLSTATE would be wrong for the same reason it was wrong in J1: the trigger raises
 * check_violation (23514), and so do waitlist_intended_member_type_check and every other CHECK in
 * the schema. An unrelated constraint failure must keep its own message.
 */
export const COMMUNITY_CONFLICT_SENTINEL =
  'a live invitation for this address already intends a different community'

export function isCommunityConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { message?: unknown; details?: unknown }
  const text = [e.message, e.details].filter((v): v is string => typeof v === 'string').join(' ')
  return text.includes(COMMUNITY_CONFLICT_SENTINEL)
}

/** Admin-facing copy for a refused designation. Names no address and no row id. */
export function communityConflictMessage(intended: IntendedMemberType): string {
  const other = intended === 'next' ? 'Andrel Professional' : 'Andrel Next'
  return `Another live invitation for this email address is already designated ${other}. ` +
    `Revoke that invitation before issuing this one.`
}

/** Admin-facing copy for a designation attempted outside approved/contacted. */
export const DESIGNATION_LOCKED_MESSAGE =
  'The community can only be chosen before the invitation is sent. ' +
  'Revoke this invitation and issue a new one to change it.'
