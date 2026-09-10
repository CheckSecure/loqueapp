import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'

/**
 * PHASE 4A-2 — the provisioning boundary, and the pin that keeps it single-consumer.
 *
 * Migration 100 makes a BEFORE INSERT trigger on public.profiles the authorization boundary for
 * creating a first profile, and removes profiles.member_type's DEFAULT so that omitting the column
 * means "derive from the invitation" rather than "silently Professional".
 *
 * ─── WHY THE 4A-1 TYPESCRIPT ZERO-CALLER GUARD IS NOT TOUCHED ─────────────────────────────────
 * phase4a1-next-designation.test.ts asserts that NO production TypeScript consults
 * resolve_intended_member_type. That guard was written expecting 4A-2 to introduce a TypeScript
 * provisioner and therefore to fail here. It does not, because the consumer this stage introduces
 * is a DATABASE TRIGGER: no application code learns about communities at all, and all three
 * profile writers keep omitting member_type entirely.
 *
 * That is a stronger outcome than the one anticipated, so the 4A-1 guard survives unchanged and
 * keeps meaning what it says. What moved is WHERE the consumer lives, so this file adds the
 * matching pin on the SQL side. Between them: exactly one consumer, in exactly one place, and a
 * second one anywhere fails a test until it is explicitly reviewed.
 */

const MIGRATION = 'supabase/migrations/100_provisioning_authorization_and_community_binding.sql'
const SQL = readFileSync(MIGRATION, 'utf8')

/** Executable lines only — comments in these files quote object names constantly. */
const executable = (src: string) =>
  src.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

/**
 * INVOCATIONS of a function, as opposed to statements ABOUT it.
 *
 * `public.f(` also appears in CREATE / REVOKE / GRANT / COMMENT / DROP / ALTER, and inside the
 * single-quoted arguments of to_regprocedure() and has_function_privilege(). Neither is a call, and
 * counting them would make this guard meaningless — 099 would look like a consumer of its own
 * resolver. The lookbehind drops the quoted forms; the keyword filter drops the DDL.
 */
const invocations = (src: string, fn: string): string[] =>
  executable(src)
    .split('\n')
    .filter((l) => !/^\s*(CREATE|REVOKE|GRANT|COMMENT|DROP|ALTER)\b/i.test(l))
    .filter((l) => new RegExp(`(?<!')public\\.${fn}\\(`).test(l))
    .map((l) => l.trim())

const migrationsCalling = (fn: string): string[] =>
  readdirSync('supabase/migrations')
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => invocations(readFileSync(`supabase/migrations/${f}`, 'utf8'), fn).length > 0)
    .sort()

/** The body of one plpgsql function within the migration, so a call can be located inside it. */
const functionBody = (name: string): string => {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  expect(start, `${name} is not defined in migration 100`).toBeGreaterThan(-1)
  const end = SQL.indexOf('\n$$;', start)
  expect(end, `${name} has no terminating $$;`).toBeGreaterThan(start)
  return SQL.slice(start, end)
}

// ═══ THE PIN ═════════════════════════════════════════════════════════════════════════════════
describe('resolve_intended_member_type has exactly ONE authorized consumer, and it is the trigger', () => {
  it('migration 100 is the only migration that CALLS the resolver', () => {
    // 099 defines, grants and asserts it but never calls it — which is what "4A-1 ships no
    // production writer" meant. If a second migration appears here, a second consumer exists and
    // this must be reviewed rather than re-baselined.
    expect(migrationsCalling('resolve_intended_member_type'))
      .toEqual(['100_provisioning_authorization_and_community_binding.sql'])
  })

  it('and it calls it exactly once, inside the binding trigger function', () => {
    const calls = invocations(SQL, 'resolve_intended_member_type')
    expect(calls).toHaveLength(1)
    expect(functionBody('tg_profiles_provision_bind')).toContain(calls[0])
  })

  it('the call is guarded: anything but outcome=resolved raises', () => {
    const body = functionBody('tg_profiles_provision_bind')
    expect(body).toMatch(/v_intent\s*:=\s*public\.resolve_intended_member_type\(NEW\.email\)/)
    expect(body).toMatch(/<>\s*'resolved'[\s\S]{0,220}RAISE EXCEPTION/)
  })
})

describe('may_provision_profile has only its authorized consumers', () => {
  it('migration 100 is the only migration that calls it', () => {
    expect(migrationsCalling('may_provision_profile'))
      .toEqual(['100_provisioning_authorization_and_community_binding.sql'])
  })

  it('exactly two call sites: the trigger, and the postapply census', () => {
    const calls = invocations(SQL, 'may_provision_profile')
    expect(calls).toHaveLength(2)
    // One is the boundary itself.
    expect(functionBody('tg_profiles_provision_bind')).toContain(calls[0])
    // The other is the read-only historical census in the postapply block, which REPORTS and never
    // enforces — the two known legacy profiles must not fail the migration.
    expect(calls[1]).toContain("<> 'authorized'")
    expect(SQL).toMatch(/RAISE NOTICE '100: % of % existing profiles would not be re-provisionable/)
  })

  it('no production TypeScript calls it — the boundary is the database, not the application', () => {
    // The J1 pre-check in completeOnboarding is a SEPARATE, later, reviewed step. When it lands it
    // must be pinned to exactly one file here, never widened to "any file".
    const hits = execSync(
      "grep -rn 'may_provision_profile' --include='*.ts' --include='*.tsx' app lib components 2>/dev/null || true",
      { encoding: 'utf8' },
    ).split('\n').filter(Boolean).filter((l) => !l.includes('__tests__'))
    const files = Array.from(new Set(hits.map((l) => l.split(':')[0])))
    expect(files).toEqual(['lib/db/migrationHealth.ts'])
    expect(readFileSync('lib/db/migrationHealth.ts', 'utf8'))
      .not.toMatch(/\.rpc\(\s*['"]may_provision_profile/)
  })
})

// ═══ THE BOUNDARY ITSELF ═════════════════════════════════════════════════════════════════════
describe('the migration binds the community at the first INSERT and nowhere else', () => {
  it('removes the DEFAULT, and keeps NOT NULL and the CHECK', () => {
    const code = executable(SQL)
    expect(code).toMatch(/ALTER TABLE public\.profiles ALTER COLUMN member_type DROP DEFAULT/)
    expect(code).not.toMatch(/ALTER COLUMN member_type (SET DEFAULT|DROP NOT NULL)/)
    expect(code).not.toMatch(/DROP CONSTRAINT profiles_member_type_check/)
  })

  it('the trigger is BEFORE INSERT FOR EACH ROW and named to fire before the stamp trigger', () => {
    expect(executable(SQL)).toMatch(
      /CREATE TRIGGER profiles_provision_bind_bi\s+BEFORE INSERT ON public\.profiles\s+FOR EACH ROW/)
    // Ordering is asserted from the catalog in the postapply block, not inferred from the name.
    expect('profiles_provision_bind_bi' < 'stamp_intro_guidance_enrollment').toBe(true)
    expect(SQL).toMatch(/ARRAY\['profiles_provision_bind_bi', 'stamp_intro_guidance_enrollment'\]/)
  })

  it('has no bypass of any kind', () => {
    // String literals are stripped first: a bypass is CODE, not prose. The precheck legitimately
    // says "…which can bypass a row trigger" inside a RAISE message, and matching that would be
    // matching the explanation rather than the mechanism.
    const code = executable(SQL).replace(/'(?:[^']|'')*'/g, "''")
    expect(code).not.toMatch(/ADMIN_EMAIL|bizdev91|is_admin|allow_|override|session_user|current_setting/i)
    expect(code).not.toMatch(/correct_member_type|change_member_type|set_member_type|promote_member/i)
    // No role is exempted from the trigger — service_role holds EXECUTE on the authorizer, which is
    // how it ASKS, not a way around being asked.
    expect(code).not.toMatch(/current_user|current_role|pg_has_role/i)
  })

  it('refusal messages carry a reason code and never an identifier', () => {
    const body = functionBody('tg_profiles_provision_bind')
    const raises = Array.from(body.matchAll(/RAISE EXCEPTION\s+([\s\S]*?)USING ERRCODE/g)).map((m) => m[1])
    expect(raises.length).toBeGreaterThanOrEqual(4)
    for (const r of raises) {
      // completeOnboarding returns a failed write's message straight to the browser, so anything a
      // RAISE can say, a member can read.
      expect(r).not.toMatch(/NEW\.email|NEW\.id|v_norm|p_email|p_auth_user_id/)
    }
  })

  it('may_provision_profile emits reason CODES from a closed vocabulary, never a row value', () => {
    const body = functionBody('may_provision_profile')
    const reasons = Array.from(body.matchAll(/'reason',\s*'([a-z_]+)'/g)).map((m) => m[1]).sort()
    expect(reasons).toEqual([
      'identity_absent', 'identity_ambiguous', 'identity_mismatch', 'no_auth_user', 'no_email',
      'waitlist_absent', 'waitlist_conflicting', 'waitlist_duplicate', 'waitlist_not_invited',
    ])
    // Every 'reason' key is followed by a quoted literal. Counting the literal form and the total
    // occurrences and requiring them equal is what proves no reason is ever built from a value.
    const literalReasons = (body.match(/'reason',\s*'/g) ?? []).length
    const allReasons = (body.match(/'reason',/g) ?? []).length
    expect(literalReasons).toBe(allReasons)
  })

  it('authorization is POSITIVE — exactly one invited row, never "not revoked"', () => {
    const body = functionBody('may_provision_profile')
    expect(body).toMatch(/v_invited\s*,\s*0\s*\)\s*<>\s*1|COALESCE\(v_invited, 0\) <> 1/)
    // The inverted test is 099's resolver's business and must not appear in the authorizer.
    expect(body).not.toMatch(/<>\s*'revoked'/)
  })

  /**
   * The behavioural proof for these lives in supabase/tests/phase4a2/concurrency_proof.sh, which
   * runs two independent connections and measures blocking from pg_stat_activity. It is NOT run
   * here: it needs a local PostgreSQL toolchain and takes ~40s of deliberate waiting, and a timing
   * test in the ordinary suite is exactly the kind of flake that gets muted and then ignored.
   *
   * What IS durable is the STRUCTURE the measured behaviour depends on. These two assertions are
   * the two ways it could regress silently, and neither involves timing.
   */
  it('the trigger takes its waitlist lock BEFORE asking whether provisioning is allowed', () => {
    const body = functionBody('tg_profiles_provision_bind')
    expect(body).toMatch(/FOR SHARE/)
    // The lock must be on the waitlist rows for this normalised address, and it must precede the
    // authorization read — locking afterwards would serialise nothing.
    const lock = body.indexOf('FOR SHARE')
    expect(body.slice(0, lock)).toMatch(/FROM public\.waitlist w/)
    expect(lock).toBeLessThan(body.indexOf('may_provision_profile'))
  })

  it('the volatility split that makes the post-lock read observe a committed revoke', () => {
    // MEASURED (scenario 3): after the trigger's FOR SHARE unblocks, a revoke that committed while
    // it waited IS observed, and provisioning is refused. That depends on the trigger being
    // VOLATILE — a volatile function takes a fresh snapshot for each statement it runs, and the
    // STABLE authorizer then inherits that fresh snapshot. Declaring the trigger STABLE would keep
    // the lock, silently reintroduce the stale read, and no existing assertion would notice.
    const trigger = functionBody('tg_profiles_provision_bind')
    expect(trigger).not.toMatch(/\bSTABLE\b|\bIMMUTABLE\b/)
    expect(functionBody('may_provision_profile')).toMatch(/\bSTABLE\b/)
  })

  it('the two questions stay in two functions', () => {
    // may_provision_profile must not learn about communities…
    expect(functionBody('may_provision_profile')).not.toMatch(/member_type|resolve_intended/)
    // …and the trigger must consult BOTH, in that order: whether, then which.
    const body = functionBody('tg_profiles_provision_bind')
    expect(body.indexOf('may_provision_profile'))
      .toBeLessThan(body.indexOf('resolve_intended_member_type'))
  })
})

// ═══ THE EXTRACTED RESOLVERS THE HARNESS MEASURES ════════════════════════════════════════════
describe('the phase4a2 harness measures the real 078 resolvers', () => {
  it('every extracted body still appears verbatim in migration 078', () => {
    const source = readFileSync('supabase/migrations/078_invitation_resume_tokens.sql', 'utf8')
    const generated = readFileSync('supabase/tests/phase4a2/resolvers_078.sql', 'utf8')
    for (const name of ['lookup_auth_identity', 'lookup_waitlist_identity']) {
      const start = generated.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
      expect(start, `${name} missing from the generated file`).toBeGreaterThan(-1)
      const end = generated.indexOf('$fn$;', start) + '$fn$;'.length
      const body = generated.slice(start, end)
      expect(body.length).toBeGreaterThan(200)
      expect(source, `${name} has drifted from 078 — regenerate`).toContain(body)
    }
  })
})
