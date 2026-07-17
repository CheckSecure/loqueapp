/**
 * Canonical email normalization used at EVERY entry point (login, invite,
 * registration, admin lookups) so the same address can never map to two
 * accounts or fail to match one. Pure and dependency-free so it is safe to
 * import from client components (the login form) as well as server code.
 *
 * `lib/invitations.ts` re-exports this so server callers keep a single import.
 */
export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase()
}
