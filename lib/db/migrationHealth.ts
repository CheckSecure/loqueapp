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
  /**
   * For a CLEANUP migration (kind 'column'): the feature is APPLIED when the column is
   * ABSENT (e.g. a legacy column has been dropped). Inverts the column probe so the banner
   * flags "cleanup still pending" while the column lingers, and clears once it's gone.
   */
  expectAbsent?: boolean
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

  {
    migration: '041_profiles_current_focus_areas.sql',
    kind: 'column',
    table: 'profiles',
    column: 'current_focus_areas',
    feature: 'Current focus areas (timely topical interests)',
    impact: 'Focus-area edits are not persisted (the write fails open and no-ops); the field is hidden and never affects completion, onboarding, or matching until applied.',
  },
  {
    migration: '042_profile_roles.sql',
    kind: 'table',
    table: 'profile_roles',
    feature: 'Additional roles & affiliations',
    impact: 'Members cannot add or view additional roles (reads fail open to empty, writes return a graceful "not available" error); primary identity, completion, and matching are unaffected until applied.',
  },

  {
    migration: '043_profiles_relationship_read_policy.sql',
    kind: 'table',
    table: 'public_profiles',
    feature: 'Relationship-scoped profiles RLS + safe public_profiles view',
    impact: 'CRITICAL: until applied, profiles RLS remains permissive (any authenticated member can enumerate the full directory client-side). The public_profiles view is the applied-signal for this migration.',
  },
  {
    migration: '044_profiles_show_activity_status.sql',
    kind: 'column',
    table: 'profiles',
    column: 'show_activity_status',
    feature: 'Presence opt-out ("Show when I\'m active")',
    impact: 'The activity opt-out preference cannot be read or saved until applied; the presence RPC (046) treats everyone as visible-eligible. Applied together with 046.',
  },
  {
    // BASE schema for automatic calendar invitations. 047 adds a column to the table this
    // migration creates, so 045 must be applied before 047 — registering it explicitly
    // makes omitting the calendar base (as an earlier deploy note did) impossible to miss.
    migration: '045_meeting_calendar_invites.sql',
    kind: 'table',
    table: 'meeting_calendar_invites',
    feature: 'Calendar-invite base schema (meetings.calendar_sequence + meeting_calendar_invites)',
    impact: 'Until applied, confirmation/cancellation calendar invites cannot be recorded or de-duplicated; the accept/delete calendar blocks fail open and send nothing. Required before 046/047.',
  },
  {
    // EXPANSION half of the presence privacy split. The member_presence table (created here
    // alongside the coarse-label RPC + backfill) is the applied-signal. It does NOT drop
    // profiles.last_active_at — that is the separate cleanup migration 048.
    migration: '046_member_presence_expansion.sql',
    kind: 'table',
    table: 'member_presence',
    feature: 'Data-boundary presence privacy (private member_presence + coarse-label RPC)',
    impact: 'CRITICAL for presence privacy: until applied, member_presence + the coarse-label RPC do not exist, so the Network presence badge shows nothing (fails closed). Backward-compatible: the legacy profiles.last_active_at column remains until cleanup migration 048.',
  },
  {
    migration: '047_calendar_invite_payload.sql',
    kind: 'column',
    table: 'meeting_calendar_invites',
    column: 'payload',
    feature: 'Durable calendar-invite payload (crash-safe / post-deletion cancel retry)',
    impact: 'Until applied, a claimed invite stores no rendered payload, so a failed cancellation cannot be retried after the meeting row is deleted (initial inline send is unaffected). Requires 045.',
  },
  {
    // CLEANUP half of the presence privacy split. Inverted probe: this is "applied" only
    // once the legacy column is GONE. Run ONLY after the new code is deployed + verified.
    migration: '048_drop_profiles_last_active_at.sql',
    kind: 'column',
    table: 'profiles',
    column: 'last_active_at',
    expectAbsent: true,
    feature: 'Presence privacy cleanup (drop legacy profiles.last_active_at)',
    impact: 'While pending, the legacy profiles.last_active_at column still exists and remains row-readable — the presence privacy boundary is not fully closed until this cleanup runs. Safe to defer, but required to finish the rollout.',
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
    // Cleanup expectation: "applied" means the column is GONE (inverted probe).
    if (e.expectAbsent) {
      if (!r.error) return { present: false } // column still exists → cleanup pending
      const sig = `${r.error.message || ''} ${r.error.code || ''}`
      if (ABSENT_RE.test(sig)) return { present: true } // column dropped → cleanup applied
      return { present: true, error: r.error.message } // unknown error → don't false-alarm
    }
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
