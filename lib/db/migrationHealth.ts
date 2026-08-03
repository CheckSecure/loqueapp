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
  {
    migration: '025_profiles_legal_acceptance.sql',
    kind: 'column',
    table: 'profiles',
    column: 'terms_version_accepted',
    feature: 'Clickwrap legal acceptance tracking',
    impact: 'The Terms/Privacy acceptance gate self-disables (compatibility mode) — access is not blocked on acceptance until applied.',
  },
  {
    migration: '026_profiles_legal_grandfathering.sql',
    kind: 'column',
    table: 'profiles',
    column: 'terms_grandfathered_through_version',
    feature: 'Version 1.0 legal grandfathering (access exemption)',
    impact: 'The acceptance gate self-disables (compatibility mode) — existing members are not yet grandfathered and access is not gated until applied.',
  },
  {
    migration: '027_meetings_scheduled_timezone.sql',
    kind: 'column',
    table: 'meetings',
    column: 'scheduled_timezone',
    feature: 'Persisted meeting timezone for email local-time display',
    impact: 'Meeting timezone is not stored (writes fall back to omitting it); acceptance emails show date + UTC only until applied.',
  },
  {
    migration: '028_waitlist_recommendation_contact.sql',
    kind: 'column',
    table: 'waitlist',
    column: 'recommendation_email_sent_at',
    feature: 'Warm recommendation "Contacted" tracking',
    impact: 'Contacted timestamps are not stored (send-recommendation sets status only); the Contacted state still works but loses its date until applied.',
  },
  {
    migration: '029_waitlist_revoked.sql',
    kind: 'column',
    table: 'waitlist',
    column: 'revoked_at',
    feature: 'Admin Revoke Invite audit timestamp',
    impact: 'Revoke still works (status set to revoked) but the revoked_at timestamp is not stored until applied.',
  },
  {
    migration: '030_companies_merge.sql',
    kind: 'column',
    table: 'companies',
    column: 'company_status',
    feature: 'Company merge/lifecycle model',
    impact: 'Company dedupe/merge lifecycle (active/pending_review/merged, tombstones) is unavailable; company-normalization Phase 0 is inert until applied.',
  },
  {
    migration: '031_company_aliases.sql',
    kind: 'table',
    table: 'company_aliases',
    feature: 'Runtime company alias authority',
    impact: 'Alias resolution falls back to the compiled registry only; admin/backfill-added aliases are unavailable until applied.',
  },
  {
    migration: '032_profiles_company_id.sql',
    kind: 'column',
    table: 'profiles',
    column: 'company_id',
    feature: 'Canonical company FK on profiles',
    impact: 'profiles.company_id resolution/backfill is inert; company association stays slug-derived only until applied.',
  },
  {
    migration: '035_profiles_referral_campaign_sent.sql',
    kind: 'column',
    table: 'profiles',
    column: 'referral_campaign_sent_at',
    feature: 'One-time member referral-campaign dedupe',
    impact: 'The referral campaign cannot dedupe/resume (every member reads as un-sent); DO NOT run the campaign until applied.',
  },
  {
    migration: '036_referrals_relationship.sql',
    kind: 'column',
    table: 'referrals',
    column: 'relationship',
    feature: 'Optional relationship context on nominations',
    impact: 'The optional Relationship field is dropped on submit (the route fails open and inserts without it); nominations otherwise work until applied.',
  },
  {
    migration: '037_referrals_referrer_consent.sql',
    kind: 'column',
    table: 'referrals',
    column: 'referrer_consent_to_share',
    feature: 'Referrer consent to be named in nominee outreach',
    impact: 'Referrer-consent is unstorable (submit fails open) so every referral is treated as no-consent (invite flow stays anonymous); the referral campaign send route refuses to run until applied.',
  },
  {
    migration: '039_profiles_intro_prompt_dismissed.sql',
    kind: 'column',
    table: 'profiles',
    column: 'intro_profile_prompt_dismissed_at',
    feature: 'Dismissal for the Introductions "Improve your recommendations" prompt',
    impact: 'The "Not now" dismissal is not persisted (the card can reappear next visit); the card still auto-retires when the matching profile is complete. No matching impact.',
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
