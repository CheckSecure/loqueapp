// Schema / migration health check.
//
// The app's schema is applied by operator-run migrations, which can lag behind a
// code deploy. When that happens the code silently runs in "compatibility mode"
// (e.g. enrichment versioning goes inert because companies.enrichment_version is
// missing) — easy to miss. This module declares the schema features the current
// code expects, each tied to the migration that provides it, and probes them
// read-only so an unapplied migration is surfaced instead of hidden.
//
// Add an entry here whenever new code depends on a not-yet-guaranteed column or
// table; the admin dashboard banner and /api/admin/migration-health pick it up.

export interface SchemaExpectation {
  /** Migration filename that provides the feature. */
  migration: string
  kind: 'column' | 'table'
  table: string
  /** Required for kind 'column'. */
  column?: string
  /** Short human name of the capability. */
  feature: string
  /** What degrades while the migration is unapplied. */
  impact: string
}

/** Features the current code expects, each backed by a specific migration. */
export const SCHEMA_EXPECTATIONS: SchemaExpectation[] = [
  {
    migration: '024_enrichment_version.sql',
    kind: 'column',
    table: 'companies',
    column: 'enrichment_version',
    feature: 'Company enrichment versioning',
    impact: 'Enrichment version tracking is disabled — outdated-version detection is inert (compatibility mode).',
  },
  {
    migration: '015_company_metadata.sql',
    kind: 'table',
    table: 'company_metadata',
    feature: 'Curated company-metadata fallback',
    impact: 'Admin-curated company descriptions/logos fallback is unavailable.',
  },
]

export interface MigrationWarning extends SchemaExpectation {
  message: string
}

export interface MigrationHealth {
  ok: boolean
  checked: number
  pending: MigrationWarning[]
}

/** The user-facing warning string for an unapplied migration. */
export function migrationWarningMessage(e: SchemaExpectation): string {
  return `Database migration ${e.migration} has not been applied. Running in compatibility mode.`
}

// PostgREST signatures for "this column/table isn't in the schema" — a missing
// feature, not a transient failure. Anything else (network, auth) is treated as
// "present" so we never cry wolf and show a false migration warning.
const ABSENT_RE = /does not exist|schema cache|could not find|42703|42P01|PGRST20[45]/i

/** Probe one expectation read-only. Returns whether the schema feature is present. */
export async function probeExpectation(admin: any, e: SchemaExpectation): Promise<{ present: boolean; error?: string }> {
  try {
    // NB: no { head: true } — a HEAD request skips column validation and would
    // mask a missing column. A real (limit 1) select parses the column list and
    // errors on an unknown column or table.
    const col = e.kind === 'column' ? (e.column as string) : '*'
    const r = await admin.from(e.table).select(col).limit(1)
    if (!r.error) return { present: true }
    const sig = `${r.error.message || ''} ${r.error.code || ''}`
    if (ABSENT_RE.test(sig)) return { present: false, error: r.error.message }
    return { present: true, error: r.error.message } // unknown error → don't false-alarm
  } catch (err: any) {
    return { present: true, error: err?.message } // transient → don't false-alarm
  }
}

/**
 * Probe every schema expectation and return the unapplied ones. Read-only and
 * resilient: a probe that errors for a non-schema reason is treated as present.
 */
export async function checkMigrationHealth(
  admin: any,
  expectations: SchemaExpectation[] = SCHEMA_EXPECTATIONS,
): Promise<MigrationHealth> {
  const pending: MigrationWarning[] = []
  for (const e of expectations) {
    const { present } = await probeExpectation(admin, e)
    if (!present) pending.push({ ...e, message: migrationWarningMessage(e) })
  }
  return { ok: pending.length === 0, checked: expectations.length, pending }
}

export interface GateDecision {
  /** Pending migrations that BLOCK the deployment (not covered by compat mode). */
  blocking: MigrationWarning[]
  /** Pending migrations explicitly waived by the declared compatibility mode. */
  waived: MigrationWarning[]
  /** True when the deployment may proceed (nothing blocking). */
  pass: boolean
}

/**
 * Decide a deployment gate from pending migrations + a declared compatibility
 * spec. `allowCompatibility` accepts `1`/`true`/`all` (waive every pending
 * migration) or a comma-separated list of migration filenames (waive only
 * those). Anything pending and not waived is blocking. Pure — used by the CLI
 * gate (scripts/check-migrations.ts) and unit-tested.
 */
export function evaluateMigrationGate(
  pending: MigrationWarning[],
  allowCompatibility: string | null | undefined,
): GateDecision {
  const raw = (allowCompatibility || '').trim()
  const allowAll = /^(1|true|yes|on|all)$/i.test(raw)
  const allowList = new Set(
    raw.split(',').map((s) => s.trim()).filter((s) => s && !/^(1|true|yes|on|all)$/i.test(s)),
  )
  const blocking: MigrationWarning[] = []
  const waived: MigrationWarning[] = []
  for (const p of pending) {
    if (allowAll || allowList.has(p.migration)) waived.push(p)
    else blocking.push(p)
  }
  return { blocking, waived, pass: blocking.length === 0 }
}
