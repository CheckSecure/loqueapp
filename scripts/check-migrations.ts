/**
 * Deployment migration-health gate.
 *
 * Invokes the SAME underlying check as /api/admin/migration-health
 * (checkMigrationHealth) against the target database and exits non-zero when a
 * required migration has not been applied — so a code deploy that outran its
 * schema is blocked in CI instead of silently running in compatibility mode.
 *
 * Usage:
 *   npm run check:migrations            # CI / manual — always runs the check
 *   tsx scripts/check-migrations.ts --require-enforce-flag   # build hook: only
 *                                         runs when ENFORCE_MIGRATIONS is set
 *
 * Env:
 *   NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL   target DB URL
 *   SUPABASE_SERVICE_ROLE_KEY                 service-role key (read-only usage)
 *   ALLOW_COMPATIBILITY_MODE                  escape hatch: `all` (or 1/true) to
 *                                             waive every pending migration, or a
 *                                             comma-separated list of migration
 *                                             filenames to waive only those.
 *   ENFORCE_MIGRATIONS                        with --require-enforce-flag, gate
 *                                             only runs when this is truthy.
 *
 * Exit codes: 0 = may deploy (ok, or all pending waived, or skipped fail-safe);
 *             1 = blocked (required migrations missing and not waived).
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { checkMigrationHealth, evaluateMigrationGate } from '../lib/db/migrationHealth'

// Local convenience: load .env.local if present. No-op in CI (env is injected).
config({ path: '.env.local' })

const TRUTHY = /^(1|true|yes|on)$/i
const log = (m: string) => process.stdout.write(`${m}\n`)

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.includes('--require-enforce-flag') && !TRUTHY.test(process.env.ENFORCE_MIGRATIONS || '')) {
    log('[migration-gate] ENFORCE_MIGRATIONS not set — skipping build-time gate.')
    return 0
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    // Can't verify without credentials — fail-safe (don't block on missing env).
    log('[migration-gate] No Supabase credentials in env — cannot verify migrations; skipping (fail-safe).')
    return 0
  }

  const admin = createClient(url, key, { auth: { persistSession: false } })
  const health = await checkMigrationHealth(admin)

  if (health.ok) {
    log(`[migration-gate] OK — all ${health.checked} expected migrations are applied.`)
    return 0
  }

  const { blocking, waived, pass } = evaluateMigrationGate(health.pending, process.env.ALLOW_COMPATIBILITY_MODE)
  for (const w of waived) log(`[migration-gate] WAIVED (compatibility mode declared): ${w.migration}`)
  for (const b of blocking) log(`[migration-gate] MISSING: ${b.message}  — ${b.impact}`)

  if (pass) {
    log(`[migration-gate] OK — ${waived.length} pending migration(s) explicitly waived via ALLOW_COMPATIBILITY_MODE.`)
    return 0
  }

  log('')
  log(`[migration-gate] FAILED — ${blocking.length} required migration(s) not applied.`)
  log('[migration-gate] Fix: apply them in Supabase, or declare compatibility mode via')
  log('[migration-gate]      ALLOW_COMPATIBILITY_MODE=all  (or a comma-separated list of migration filenames).')
  return 1
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // A bug in the gate itself must not permanently block deploys → fail-safe.
    console.warn('[migration-gate] gate errored (skipping, fail-safe):', err?.message || err)
    process.exit(0)
  })
