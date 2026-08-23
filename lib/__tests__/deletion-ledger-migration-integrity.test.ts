import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

/**
 * Structural guards for the APPLIED deletion-ledger migrations.
 *
 * Migration 075 is a production artifact. It has been applied, and the repository copy must stay
 * byte-for-byte identical to what was applied — a "harmless" reformat would silently desynchronise
 * the repository from the live database, and nothing else in the codebase would notice.
 *
 * Migration 076 records a permission correction that was applied MANUALLY in production after 075's
 * post-apply audit found public.tg_account_deletion_events_append_only() executable by PUBLIC, anon,
 * authenticated and service_role. Two defaults stacked to cause it: PostgreSQL grants EXECUTE on
 * every new function to PUBLIC by itself, and Supabase's ALTER DEFAULT PRIVILEGES adds explicit
 * role entries on top. 075 revoked on six of its seven functions and missed this one.
 *
 * The BEHAVIOURAL proof is scripts/verify-075-deletion-ledger.sh, which applies both migrations to a
 * disposable PostgreSQL cluster that reproduces those defaults, CONFIRMS THE DEFECT IS PRESENT after
 * 075 alone, and then proves 076 removes it — 124 assertions in total. A bare cluster without those
 * defaults cannot reproduce the defect and would report a meaningless pass.
 */

const M75_PATH = 'supabase/migrations/075_account_deletion_ledger.sql'
const M76_PATH = 'supabase/migrations/076_account_deletion_ledger_acl_correction.sql'
const M75_SHA = '62ec9710f7aa0fa094fc2551deb9da42ef09eca166e214c9d1aea4a08226920f'

const M75_BYTES = readFileSync(M75_PATH)
const M75 = M75_BYTES.toString('utf8')
const M76 = readFileSync(M76_PATH, 'utf8')
const HARNESS = readFileSync('scripts/verify-075-deletion-ledger.sh', 'utf8')
const POSTAPPLY = readFileSync('supabase/audits/075_postapply.sql', 'utf8')

const FN = 'tg_account_deletion_events_append_only'

/**
 * Executable SQL only, with `--` line comments removed. These migrations document their own root
 * cause in prose, so they legitimately CONTAIN the strings "CREATE FUNCTION",
 * "account_deletion_events" and "has_function_privilege('PUBLIC'" — the first as an explanation of
 * PostgreSQL's default, the last as an explanation of why it must NOT be used. Asserting against the
 * raw text would fail on the documentation rather than on the code.
 */
const code = (sql: string) =>
  sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

const M76_CODE = code(M76)
const POSTAPPLY_CODE = code(POSTAPPLY)

describe('075 is an applied artifact and must not drift', () => {
  it('matches the checksum of what was applied to production', () => {
    expect(createHash('sha256').update(M75_BYTES).digest('hex')).toBe(M75_SHA)
  })

  it('matches the applied byte and line counts', () => {
    expect(M75_BYTES.length).toBe(32193)
    expect(M75.split('\n').length - 1).toBe(531)
  })
})

describe('076 reproduces the manual correction, and only that', () => {
  it('revokes from PUBLIC, anon and authenticated — each named explicitly', () => {
    for (const grantee of ['PUBLIC', 'anon', 'authenticated']) {
      expect(M76).toMatch(
        new RegExp(`REVOKE ALL\\s*\\n\\s*ON FUNCTION public\\.${FN}\\(\\)\\s*\\n\\s*FROM ${grantee};`))
    }
  })

  it('preserves service_role execution', () => {
    expect(M76).toMatch(new RegExp(`GRANT EXECUTE\\s*\\n\\s*ON FUNCTION public\\.${FN}\\(\\)\\s*\\n\\s*TO service_role;`))
  })

  it('revokes BEFORE granting — a GRANT is additive and removes nothing', () => {
    expect(M76.indexOf('REVOKE ALL')).toBeLessThan(M76.indexOf('GRANT EXECUTE'))
  })

  it('does not replace, alter or recreate the function', () => {
    expect(M76_CODE).not.toMatch(/CREATE\s+(OR REPLACE\s+)?FUNCTION/i)
    expect(M76_CODE).not.toMatch(/ALTER FUNCTION/i)
    expect(M76_CODE).not.toMatch(/DROP FUNCTION/i)
  })

  it('does not touch any table or trigger', () => {
    expect(M76_CODE).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(TABLE|TRIGGER|INDEX|POLICY)\b/i)
    // the only identifier 076 may name is the function; the TABLE must not appear in its SQL
    expect(M76_CODE).not.toMatch(/account_deletion_events\b(?!_append_only)/)
  })

  it('contains no production DML of any kind', () => {
    expect(M76).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|COPY)\b/mi)
  })

  it('fails loudly if 075 has not been applied, rather than silently no-opping', () => {
    expect(M76).toMatch(new RegExp(`to_regprocedure\\('public\\.${FN}\\(\\)'\\) IS NULL`))
    expect(M76).toMatch(/RAISE EXCEPTION/)
  })

  it('states the root cause including PostgreSQL’s own PUBLIC default', () => {
    expect(M76).toMatch(/PostgreSQL ITSELF grants EXECUTE on every newly created function to PUBLIC/)
    expect(M76).toMatch(/ALTER DEFAULT PRIVILEGES \.\.\. GRANT ALL ON FUNCTIONS/)
    expect(M76).toMatch(/A GRANT is additive and removes nothing; only\n-- REVOKE removes/)
  })

  it('does not overstate the severity', () => {
    expect(M76).toMatch(/The practical exploitability was low/)
    expect(M76).toMatch(/is a property of today's\n-- body, not a guarantee/)
  })

  it('records that 075 must stay byte-identical', () => {
    expect(M76).toContain(M75_SHA)
    expect(M76).toMatch(/MIGRATION 075 IS NOT MODIFIED/)
  })
})

describe('the harness models Supabase defaults and reproduces the defect', () => {
  it('grants the Supabase-style defaults on FUNCTIONS, not only TABLES', () => {
    expect(HARNESS).toMatch(/ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS\s+TO anon, authenticated, service_role;/)
    expect(HARNESS).toMatch(/ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES\s+TO anon, authenticated, service_role;/)
  })

  it('captures the defect state after 075 and BEFORE 076', () => {
    expect(HARNESS.indexOf('PRE_PUBLIC=')).toBeGreaterThan(HARNESS.indexOf('075_account_deletion_ledger.sql'))
    expect(HARNESS.indexOf('PRE_PUBLIC=')).toBeLessThan(HARNESS.indexOf('076_account_deletion_ledger_acl_correction.sql'))
  })

  it('asserts the defect was genuinely present, so a pass cannot be vacuous', () => {
    expect(HARNESS).toMatch(/chk "the defect WAS present before 076 \(PUBLIC\)" "t" "\$PRE_PUBLIC"/)
    expect(HARNESS).toMatch(/chk "the defect WAS present before 076 \(anon\)" "t" "\$PRE_ANON"/)
  })

  it('applies 076 and re-applies it to prove idempotency', () => {
    expect((HARNESS.match(/076_account_deletion_ledger_acl_correction\.sql/g) ?? []).length).toBe(2)
  })

  it('destroys the disposable cluster afterwards', () => {
    expect(HARNESS).toMatch(/trap cleanup EXIT/)
    expect(HARNESS).toMatch(/pg_ctl" -D "\$DATA" -m immediate stop/)
    expect(HARNESS).toMatch(/rm -rf "\$\(dirname "\$DATA"\)"/)
  })

  it('inspects the ACL directly rather than calling has_function_privilege on PUBLIC', () => {
    // PUBLIC is a pseudo-role: has_function_privilege('PUBLIC', ...) raises.
    expect(HARNESS).not.toMatch(/has_function_privilege\('PUBLIC'/)
    expect(POSTAPPLY_CODE).not.toMatch(/has_function_privilege\('PUBLIC'/)
    // ...while the audit still EXPLAINS why, in a comment
    expect(POSTAPPLY).toMatch(/has_function_privilege\('PUBLIC', \.\.\.\) raises/)
    expect(POSTAPPLY).toMatch(/a::text LIKE '=%'/)
    expect(POSTAPPLY).toMatch(/PUBLIC is a PSEUDO-ROLE/)
  })

  it('treats a NULL proacl as PUBLIC-executable, not as "no grants"', () => {
    // A never-touched function has proacl = NULL, which MEANS the PostgreSQL default: PUBLIC may
    // execute. Reading NULL as "nobody has access" is how this defect hides.
    expect(HARNESS).toMatch(/proacl IS NULL FROM pg_proc WHERE oid=to_regprocedure/)
    expect(POSTAPPLY).toMatch(/null acl = PostgreSQL default = PUBLIC CAN EXECUTE — FAIL/)
  })
})

describe('post-apply audit proves every required property of 076', () => {
  const required = [
    'function still exists',
    'PUBLIC cannot execute it',
    'anon cannot execute it',
    'authenticated cannot execute it',
    'service_role CAN execute it',
    'still SECURITY DEFINER',
    'still pins an empty search_path',
    'body UNCHANGED — 076 corrected privileges only',
    'append-only trigger still present AND enabled',
    'truncate-guard trigger still present AND enabled',
  ]
  for (const r of required) {
    it(`asserts: ${r}`, () => expect(POSTAPPLY).toContain(r))
  }

  it('audits EVERY ledger function’s ACL, so an omission cannot hide again', () => {
    expect(POSTAPPLY).toMatch(/5b\. all ledger function ACLs/)
    for (const fn of ['record_account_deletion_event', 'tg_capture_account_deletion', FN,
                      'account_deletion_counts_ok', 'tg_capture_profiles_truncate',
                      'purge_expired_account_deletion_events', 'delete_user_account']) {
      expect(POSTAPPLY).toContain(fn)
    }
  })

  it('is still read-only', () => {
    expect(POSTAPPLY).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|DO)\b/mi)
  })
})

describe('the ledger’s own guarantees cannot be weakened without a failure here', () => {
  it('keeps the seven-year boundary in BOTH the purge and the trigger', () => {
    const purge = M75.slice(M75.indexOf('FUNCTION public.purge_expired_account_deletion_events'))
    expect(purge).toMatch(/pg_catalog\.make_interval\(years => 7\)/)
    const trig = M75.slice(M75.indexOf(`FUNCTION public.${FN}`))
    expect(trig).toMatch(/OLD\.occurred_at >= pg_catalog\.now\(\) - pg_catalog\.make_interval\(years => 7\)/)
  })

  it('keeps the purge marker gate on DELETE', () => {
    expect(M75).toMatch(/current_setting\('andrel\.retention_purge', true\) IS DISTINCT FROM 'on'/)
    expect(M75).toMatch(/set_config\('andrel\.retention_purge', 'on', true\)/)
  })

  it('keeps both ledger triggers', () => {
    expect(M75).toMatch(/CREATE TRIGGER account_deletion_events_append_only/)
    expect(M75).toMatch(/CREATE TRIGGER account_deletion_events_no_truncate/)
  })

  it('grants the ledger table no browser privileges and defines no RLS policy', () => {
    expect(M75).toMatch(/GRANT SELECT, INSERT ON public\.account_deletion_events TO service_role;/)
    expect(M75).not.toMatch(/GRANT[^;]*ON public\.account_deletion_events TO (anon|authenticated|PUBLIC)/)
    expect(M75).not.toMatch(/CREATE POLICY/)
    expect(M75).toMatch(/ALTER TABLE public\.account_deletion_events ENABLE ROW LEVEL SECURITY/)
  })

  it('adds no historical backfill in either migration', () => {
    expect(M75).toMatch(/NO BACKFILL/)
    expect(M75).not.toMatch(/INSERT INTO public\.account_deletion_events[\s\S]{0,400}?\bSELECT\b/)
    expect(M76_CODE).not.toMatch(/account_deletion_events\b(?!_append_only)/)
  })
})

/**
 * Regression guard for a FALSE FAILURE found by the production 076 audit.
 *
 * `SET search_path = ''` is stored in pg_proc.proconfig as the single element  search_path=""  —
 * the empty value is QUOTED, because an unquoted trailing '=' would be indistinguishable from a
 * missing value. The audit compared against 'search_path=' and therefore reported FAIL for a
 * function that was correctly hardened.
 *
 * The deeper defect was not the literal. The harness compared against 'search_path=""' while the
 * audit compared against 'search_path=', so each passed on its own terms, they disagreed with each
 * other, and nothing noticed until an operator ran the audit against a real database. The harness
 * now EXECUTES the shipped audit file, so the artifact the operator runs is the artifact tested.
 */
describe('the audit recognises how PostgreSQL actually stores an empty search_path', () => {
  const EXPECTED = 'search_path=""'

  it('never compares proconfig against the unquoted "search_path=" again', () => {
    // the exact shape of the production false failure, in any spacing
    expect(POSTAPPLY_CODE).not.toMatch(/=\s*'search_path='(?!")/)
    expect(POSTAPPLY_CODE).not.toMatch(/'search_path='\s*=/)
    expect(POSTAPPLY_CODE).not.toMatch(/array_to_string\(\s*p?\.?proconfig[^)]*\)\s*=\s*'search_path='/)
  })

  it('checks EVERY proconfig assertion by exact array membership', () => {
    const assertions = POSTAPPLY_CODE.split('\n').filter(l => /proconfig/.test(l) && /=\s*ANY|search_path/.test(l))
    expect(assertions.length).toBeGreaterThanOrEqual(4)
    for (const line of assertions) {
      if (/'search_path/.test(line)) {
        expect(line).toContain(`'${EXPECTED}' = ANY(`)
      }
    }
  })

  it('corrected BOTH affected assertions, not only the reported one', () => {
    // 1: the append-only function (what production reported)  2: the purge function (same latent bug)
    const hits = POSTAPPLY_CODE.match(/'search_path=""' = ANY\(/g) ?? []
    expect(hits.length).toBeGreaterThanOrEqual(4) // 2 pass/fail assertions + 2 listing columns
    const appendOnly = POSTAPPLY_CODE.slice(POSTAPPLY_CODE.indexOf('still pins an empty search_path'))
    expect(appendOnly.slice(0, 260)).toContain(`'${EXPECTED}' = ANY(proconfig)`)
    const purge = POSTAPPLY_CODE.slice(POSTAPPLY_CODE.indexOf('SECURITY DEFINER with empty search_path'))
    expect(purge.slice(0, 260)).toContain(`'${EXPECTED}' = ANY(proconfig)`)
  })

  it('surfaces the pin as its own column in both function listings', () => {
    expect((POSTAPPLY_CODE.match(/AS search_path_pinned_empty/g) ?? []).length).toBe(2)
    expect(POSTAPPLY).toMatch(/search_path_pinned_empty = true on EVERY row/)
  })

  it('does not weaken the assertion to a substring or a LIKE', () => {
    expect(POSTAPPLY_CODE).not.toMatch(/proconfig[^\n]*LIKE\s*'%search_path/)
    expect(POSTAPPLY_CODE).not.toMatch(/array_to_string\([^)]*proconfig[^)]*\)\s*(LIKE|~)/)
    // membership, not flattening — a flattened compare can be satisfied by a longer string
    expect(POSTAPPLY_CODE).toMatch(/'search_path=""' = ANY\(proconfig\)/)
  })

  it('documents the storage representation so the literal is not folklore', () => {
    expect(POSTAPPLY).toMatch(/the empty value is QUOTED/)
    expect(POSTAPPLY).toMatch(/Comparing against 'search_path=' therefore\n  -- fails against a correctly hardened function/)
  })

  it('the harness RUNS the shipped audit instead of restating it', () => {
    expect(HARNESS).toMatch(/-f supabase\/audits\/075_postapply\.sql/)
    expect(HARNESS).toMatch(/the audit reported ZERO failures/)
    expect(HARNESS).toMatch(/the audit produced output \(an empty run must not pass\)/)
    expect(HARNESS).toMatch(/audit: 'still pins an empty search_path' => PASS/)
    expect(HARNESS).toMatch(/the artifact the operator runs is\n# the artifact that is tested/)
  })

  it('the harness proves the representation from the database, not from belief', () => {
    expect(HARNESS).toMatch(/PostgreSQL stores the empty pin as search_path=/)
    expect(HARNESS).toMatch(/and NOT as the unquoted 'search_path='/)
  })
})
