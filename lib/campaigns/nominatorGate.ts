/**
 * Nominator gate — the FAIL-CLOSED preflight that must pass before a nomination campaign touches a
 * single recipient.
 *
 * WHY THIS IS NOT OPTIONAL: the email says "<Nominator> invited you to join Andrel". The nominator's
 * identity is therefore part of the authorized campaign contract, not decorative metadata. If we
 * cannot prove exactly one valid nominator profile, we must not create an account, a waitlist row, a
 * delivery claim, a referral row, or send anything — because we would be asserting an endorsement we
 * cannot attribute.
 *
 * ESTABLISHED REFERRAL CONTRACT (audited, applied consistently here):
 *   - /api/profile/complete awards the referral credit ONLY when the referrer's
 *     profiles.account_status === 'active';
 *   - lib/referralCampaign/eligibility.ts likewise treats a member as a valid referral participant
 *     only when account_status === 'active'.
 *   This module applies the same rule at nomination time, so a campaign can never attribute an
 *   invitation to a deactivated member.
 *
 * NO UUID IS EVER HARDCODED for a campaign that lacks a confirmed id: the server-owned nominator
 * EMAIL is resolved at run time. A missing, ambiguous, or inactive nominator is a hard failure —
 * never a silent skip.
 *
 * Pure and dependency-free so the decision is unit-testable without a database.
 */

export type NominatorGateFailure =
  /** No profile matched the server-owned nominator email. */
  | 'not_found'
  /** More than one profile matched — we cannot say which member is endorsing. */
  | 'ambiguous'
  /** Exactly one profile, but it is not active (established referral contract). */
  | 'inactive'
  /** The lookup itself failed — never assume "absent" from an error. */
  | 'lookup_failed'

export type NominatorGateResult =
  | { ok: true; userId: string }
  | { ok: false; reason: NominatorGateFailure }

export interface NominatorProfileRow {
  id: string
  account_status: string | null
}

/**
 * Decide from the raw lookup. Rows are the profiles matching the nominator email (the caller must
 * request at least 2 so ambiguity is detectable). `error` is the query error, if any.
 *
 * Order matters: a lookup ERROR is never read as "not found" — an unavailable database must fail the
 * campaign, not silently proceed as though the nominator does not exist.
 */
export function evaluateNominator(
  rows: NominatorProfileRow[] | null | undefined,
  error?: unknown,
): NominatorGateResult {
  if (error) return { ok: false, reason: 'lookup_failed' }
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return { ok: false, reason: 'not_found' }
  if (list.length > 1) return { ok: false, reason: 'ambiguous' }
  const row = list[0]
  if (!row?.id) return { ok: false, reason: 'not_found' }
  if (row.account_status !== 'active') return { ok: false, reason: 'inactive' }
  return { ok: true, userId: row.id }
}

/**
 * Member-safe wording for the campaign response. Deliberately coarse: it names no email, no UUID, no
 * profile field, and does not distinguish "this address has no account" in a way that could be used
 * to probe membership. The machine-readable `reason` accompanies it for the operator.
 */
export const NOMINATOR_GATE_ERROR =
  'Campaign nominator could not be verified. Nothing was sent and nothing was created.'
