# Database migration health checks

Schema is applied by operator-run migrations (`supabase/migrations/*.sql`), which
can lag behind a code deploy. When that happens the app silently runs in
**compatibility mode** (e.g. enrichment versioning goes inert because
`companies.enrichment_version` is missing). This module surfaces that instead of
hiding it.

## What it does

[`migrationHealth.ts`](./migrationHealth.ts) declares the schema features the
current code expects — `SCHEMA_EXPECTATIONS` — each tied to the migration that
provides it. `checkMigrationHealth(admin)` probes each one **read-only** and
returns any that are unapplied, with a warning message:

> Database migration `<file>` has not been applied. Running in compatibility mode.

Surfaced in two places:

- **Admin dashboard** (`app/dashboard/admin/page.tsx`) — an amber banner listing
  every pending migration + its impact. Resilient (never blocks the dashboard)
  and also `console.warn`ed to server logs.
- **`GET /api/admin/migration-health`** (admin-only) — `{ ok, checked, pending[] }`
  for deployment / operational monitoring.

The warning **clears itself** automatically once the migration is applied (the
next probe finds the column/table and reports `ok: true`).

## Standard pattern: adding a new check (do this for every schema-dependent change)

Whenever new application code depends on a column or table that a migration adds,
add one entry to `SCHEMA_EXPECTATIONS` so the dashboard and API detect it
automatically — no per-feature wiring:

```ts
{
  migration: '025_new_feature.sql',
  kind: 'column',            // or 'table'
  table: 'some_table',
  column: 'new_column',      // required for kind 'column'
  feature: 'Human-readable capability name',
  impact: 'What degrades while this migration is unapplied.',
}
```

Guidelines:

- **Use real schema validation, never `{ head: true }`.** A HEAD request skips
  column validation and would falsely report "applied." The probe uses
  `.select(col).limit(1)`, which parses the column list and errors on a missing
  column or table.
- **Detectable kinds only.** Columns and tables are probeable read-only. CHECK
  constraint changes (e.g. widening an enum) aren't reliably detectable via
  PostgREST and are intentionally omitted — handle those with in-code graceful
  degradation (see `run.ts` `finalize`).
- **Fail safe.** A probe that errors for a non-schema reason (network/auth) is
  treated as *present* so the dashboard never shows a false migration warning.

## Deployment gate (enforceable, not just a dashboard notice)

`scripts/check-migrations.ts` invokes the **same** `checkMigrationHealth` against
the target database and **exits non-zero** when a required migration is missing —
so a deploy that outran its schema is blocked, not merely visible in the
dashboard.

```bash
npm run check:migrations   # exit 1 if required migrations are missing
```

Env:

| Var | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_URL` | target DB |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role key (read-only usage) |
| `ALLOW_COMPATIBILITY_MODE` | escape hatch — `all` (waive every pending migration) or a comma-separated list of migration filenames to waive only those |
| `ENFORCE_MIGRATIONS` | build-hook opt-in (see below) |

Fail-safe: with **no** DB credentials, or on an unexpected gate error, it exits 0
(never blocks a deploy on a gate bug). It fails **only** on a *confirmed* missing
migration that isn't waived.

### Two ways to enforce a production deploy

1. **CI status check** — `.github/workflows/migration-health.yml` runs the gate on
   push/PR to `main` (needs `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
   repo secrets). Make it a *required* status check and have Vercel wait for
   required checks so a red gate blocks the deploy.
2. **Vercel build hook** — the `prebuild` script runs the gate during `next build`
   but only when `ENFORCE_MIGRATIONS` is truthy. Set `ENFORCE_MIGRATIONS=1` in the
   Vercel **Production** environment; a missing migration then fails the build and
   the deploy. Preview/local builds are unaffected (the hook self-skips).

To ship knowingly in compatibility mode, declare it: set
`ALLOW_COMPATIBILITY_MODE` to `all` or to the specific migration filename(s).

## Currently registered

| Migration | Checks | Feature |
| --- | --- | --- |
| `024_enrichment_version.sql` | `companies.enrichment_version` column | Company enrichment versioning |
| `015_company_metadata.sql` | `company_metadata` table | Curated company-metadata fallback |
