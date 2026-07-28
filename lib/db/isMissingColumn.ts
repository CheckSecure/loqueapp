/**
 * True when a Supabase/PostgREST error means "this column/table isn't in the
 * schema yet" — i.e. a migration that adds it hasn't been applied. Lets a write
 * that references a freshly-added, nullable column degrade gracefully (retry
 * without the column) instead of failing outright if the code deploys before the
 * migration is run. Mirrors the signatures used by lib/db/migrationHealth.ts.
 *
 *   42703      — Postgres undefined_column
 *   42P01      — Postgres undefined_table
 *   PGRST204   — PostgREST: column not found in schema cache (writes)
 *   PGRST205   — PostgREST: table not found in schema cache
 */
export function isMissingColumnError(
  error: { message?: string | null; code?: string | null } | null | undefined,
): boolean {
  if (!error) return false
  const sig = `${error.message || ''} ${error.code || ''}`
  return /does not exist|schema cache|could not find|42703|42P01|PGRST20[45]/i.test(sig)
}
