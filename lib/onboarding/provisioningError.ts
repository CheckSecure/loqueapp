/**
 * lib/onboarding/provisioningError.ts — one neutral message for every provisioning refusal.
 *
 * ─── WHAT THIS IS FOR ─────────────────────────────────────────────────────────────────────────
 * Migration 100 made a BEFORE INSERT trigger on public.profiles the authorization boundary for
 * creating a first profile. When it refuses, it raises a message carrying a reason CODE:
 *
 *     profiles: provisioning refused (waitlist_not_invited)
 *
 * completeOnboarding returns a failed write's message straight to the browser
 * (`return { error: error.message }`), and OnboardingForm renders it verbatim. Without translation
 * a member sees raw PostgreSQL. This module is the translation, used at BOTH points where a
 * refusal can surface — the pre-check and the write itself — so the two can never disagree.
 *
 * ─── THIS IS UX, NOT AUTHORIZATION ────────────────────────────────────────────────────────────
 * Nothing here decides anything. The database decides, every time, including when the application
 * pre-check has already passed. See the race note in app/actions.ts.
 *
 * ─── WHY THE PREFIX AND NOT THE SQLSTATE ──────────────────────────────────────────────────────
 * All four of the trigger's refusals raise ERRCODE check_violation (23514) — but so do
 * profiles_member_type_check (migration 095) and profiles_complete_requires_location_chk
 * (migration 061). Matching 23514 would swallow those into a message about invitations, hiding a
 * genuine validation failure behind the wrong explanation. The message prefix is owned by migration
 * 100, is identical across all four of its refusals, and is asserted to still exist by
 * lib/__tests__/j1-onboarding-provisioning-ux.test.ts — so the two cannot drift apart.
 */

/**
 * The stable sentinel migration 100 emits. Every refusal from tg_profiles_provision_bind begins
 * with this, and nothing else in the schema does.
 *
 * Deliberately includes the opening parenthesis: the reason code always follows, so this cannot
 * match a sentence that merely happens to mention the phrase.
 */
export const PROVISIONING_REFUSAL_PREFIX = 'profiles: provisioning refused ('

/**
 * The ONE member-facing message for every provisioning refusal, whichever of the nine reason codes
 * fired and whether it came from the pre-check or the write.
 *
 * The browser never learns which reason it was. identity_absent, identity_ambiguous,
 * identity_mismatch, waitlist_absent, waitlist_duplicate, waitlist_not_invited,
 * waitlist_conflicting, a community mismatch and an unresolvable intent all read the same here;
 * the code goes to the server log only.
 */
export const PROVISIONING_REFUSED_MESSAGE =
  'We couldn’t complete your account setup. Your invitation may have expired or been changed. ' +
  'Please request a new invitation, or contact support if you think this is a mistake.'

/**
 * Is this database error a migration-100 provisioning refusal?
 *
 * Matches the message text only. `code` is deliberately NOT consulted — see the header. Every other
 * database error, including unrelated 23514 check violations, returns false and keeps whatever
 * behaviour it had before J1.
 *
 * Reads `details` as well as `message` because PostgREST does not guarantee which field carries a
 * RAISE's text for every error shape; both are checked so a refusal cannot slip through as a raw
 * string. Neither field is ever returned to the caller — only the boolean is used.
 */
export function isProvisioningRefusal(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { message?: unknown; details?: unknown }
  const text = [e.message, e.details].filter((v): v is string => typeof v === 'string').join(' ')
  return text.includes(PROVISIONING_REFUSAL_PREFIX)
}

/**
 * The reason code, for the SERVER LOG only. Never return this to a caller.
 * Returns null when the error is not a provisioning refusal or carries no parseable code.
 */
export function provisioningRefusalReason(error: unknown): string | null {
  if (!isProvisioningRefusal(error)) return null
  const e = error as { message?: unknown; details?: unknown }
  const text = [e.message, e.details].filter((v): v is string => typeof v === 'string').join(' ')
  const m = /profiles: provisioning refused \(([a-z_]+)\)/.exec(text)
  return m ? m[1] : null
}
