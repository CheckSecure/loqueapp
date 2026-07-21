/**
 * CANONICAL member-eligibility filter for the recommendation pipeline.
 *
 * One source of truth for "which profiles may appear in / affect recommendations",
 * used by EVERY path that surfaces one member to another (batch generation,
 * batch replacements, onboarding recommendations, concierge ranking,
 * admin simulation, and any future recommendation endpoint). It exists because
 * the per-route WHERE clauses had DRIFTED — e.g. onboarding recommendations
 * omitted the is_test_account filter, leaking a test account to real members;
 * replacements omitted the admin exclusion. A shared filter prevents that class
 * of bug from ever recurring.
 *
 * EXCLUDED (verified against production columns — only reliably-populated flags
 * are used, so we neither leak excluded accounts nor over-exclude real members):
 *   - is_test_account = true   → test / demo / seed / fake / dev accounts
 *   - is_admin = true          → internal / admin accounts
 *   - email = ADMIN_EMAIL      → belt-and-suspenders for the admin account
 *   - account_status != active → suspended / disabled / deactivated / deleted
 *   - profile_complete != true → incomplete onboarding
 *
 * Deliberately NOT used: is_approved (only the admin has it set → would exclude
 * everyone) and onboarding_complete (always false in prod → profile_complete is
 * the real onboarding gate). last_active_at is not an eligibility gate.
 *
 * Two enforcement layers (defense in depth):
 *   1. applyMemberEligibility(query)  — narrows the DB query at the source.
 *   2. isEligibleMember(profile) / filterEligible(rows) — a pure in-memory
 *      re-check applied before scoring, so an excluded account can never affect
 *      rarity/IDF, exposure balancing, or simulation even if a query forgets a
 *      clause. ELIGIBILITY_COLUMNS lists the columns callers must select for it.
 */

export const ADMIN_EMAIL = 'bizdev91@gmail.com'

/** Columns every candidate/recipient query must select so isEligibleMember can re-check. */
export const ELIGIBILITY_COLUMNS = 'account_status, profile_complete, is_test_account, is_admin, email'

export type EligibilityFields = {
  account_status?: string | null
  profile_complete?: boolean | null
  is_test_account?: boolean | null
  is_admin?: boolean | null
  email?: string | null
}

/**
 * Apply the canonical exclusions to a PostgREST query builder. Generic passthrough
 * (like the prior excludeTestAccounts) so the caller keeps its inferred row type;
 * the internal `any` avoids Supabase's deep-generic instantiation blowups.
 */
export function applyMemberEligibility<T>(query: T): T {
  return (query as any)
    .eq('account_status', 'active')
    .eq('profile_complete', true)
    .not('is_test_account', 'is', true)
    .not('is_admin', 'is', true)
    .neq('email', ADMIN_EMAIL)
}

/** Pure predicate — the same rules, for in-memory defense-in-depth. */
export function isEligibleMember(p: EligibilityFields | null | undefined): boolean {
  if (!p) return false
  return p.account_status === 'active'
    && p.profile_complete === true
    && p.is_test_account !== true
    && p.is_admin !== true
    && (p.email ?? '') !== ADMIN_EMAIL
}

/** Filter an in-memory list of profiles down to eligible members. */
export function filterEligible<T extends EligibilityFields>(profiles: T[] | null | undefined): T[] {
  return (profiles ?? []).filter(isEligibleMember)
}

/**
 * Positive exclusion reason for a profile, or null if nothing marks it excluded.
 *
 * Unlike isEligibleMember (a strict whitelist used for FILTERING), this is a
 * BLACKLIST of definite "must-not-participate" signals — it flags a KNOWN-bad
 * account without rejecting a profile that merely lacks a field. It is what the
 * fail-fast assertion reports, so a profile carrying eligibility columns that say
 * "excluded" is caught, while a synthetic object without those columns is not a
 * false positive.
 */
export function eligibilityExclusionReason(p: (EligibilityFields & { id?: string }) | null | undefined): string | null {
  if (!p) return 'null_profile'
  if (p.is_test_account === true) return 'test_account'
  if (p.is_admin === true) return 'admin_account'
  if ((p.email ?? '') === ADMIN_EMAIL) return 'admin_email'
  if (p.account_status != null && p.account_status !== 'active') return `inactive_status:${p.account_status}`
  if (p.profile_complete === false) return 'incomplete_onboarding'
  return null
}

/**
 * FAIL-FAST guard. Call immediately before scoring in every recommendation path.
 * If any excluded account reached the pool (i.e. the canonical filter was bypassed
 * by a future code change), throw loudly with the offending id/email/reason and
 * the code path — instead of silently filtering — so the mistake is impossible to
 * ship unnoticed. Because scoring in the batch pipeline can only run through
 * buildScoringContext (which calls this), an excluded account cannot reach
 * scoreMatch, rarity/IDF, exposure balancing, or simulation without aborting.
 */
export function assertAllEligible(profiles: Array<(EligibilityFields & { id?: string }) | null | undefined> | null | undefined, codePath: string): void {
  for (const p of profiles ?? []) {
    const reason = eligibilityExclusionReason(p)
    if (reason) {
      throw new Error(
        `[eligibility:fail-fast] Excluded account reached scoring at "${codePath}": ` +
        `id=${p?.id ?? '?'} email=${p?.email ?? '?'} reason=${reason}. ` +
        `All recipients/candidates must pass applyMemberEligibility + filterEligible ` +
        `(lib/matching/eligibility.ts) BEFORE any scoring. Do not bypass the canonical filter.`,
      )
    }
  }
}
