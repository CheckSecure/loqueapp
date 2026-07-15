/**
 * Internal QA-account isolation — single source of truth.
 *
 * Profiles with `is_test_account = true` are permanent internal test accounts
 * (used for production QA of messaging/notifications) and must NEVER surface to
 * real members or distort member counts. Every member-facing candidate/recipient
 * pool applies the identical rule via `excludeTestAccounts`, and any JS-side
 * eligibility check uses `isMemberFacingEligible`, so the exclusion can never
 * drift between surfaces.
 *
 * The DB condition is `is_test_account IS NOT TRUE` (true for both `false` and
 * NULL rows), so it is safe even before the column backfills.
 */

/**
 * Apply the QA-account exclusion to a PostgREST/supabase-js query chain.
 * `.not('is_test_account', 'is', true)` → `is_test_account IS NOT TRUE`.
 */
export function excludeTestAccounts<T>(query: T): T {
  return (query as any).not('is_test_account', 'is', true)
}

/** Pure predicate mirroring the DB filter — for tests and any in-memory guard. */
export function isMemberFacingEligible(
  p: { is_test_account?: boolean | null } | null | undefined,
): boolean {
  return !!p && p.is_test_account !== true
}
