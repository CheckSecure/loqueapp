import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/**
 * TWO REGRESSIONS, ONE ROOT SHAPE: server code reading a table the caller's role can no longer see.
 *
 * Migration 058 revoked SELECT on public.profiles from PUBLIC/anon/authenticated — the intended A3
 * posture. Fifteen server call sites still read that table with the CALLER's client. They began
 * failing silently, and because most destructured only `data`, a PERMISSION ERROR was indistinguishable
 * from a missing row. The member-visible symptom was "Profile not found" when nominating someone.
 *
 * The scan below is the real regression test: it fails if ANY new browser-client read of
 * public.profiles is ever introduced, rather than enumerating the fifteen known ones.
 */

/** Strip line comments so an assertion tests CODE, not the prose explaining it. */
const tsCode = (src: string) =>
  src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n')
const sqlCode = (src: string) =>
  src.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '__tests__', 'scratchpad'])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
  }
  return out
}

/** Variables in `src` bound to the CALLER-scoped Supabase client (never the service-role one). */
function browserClientVars(src: string): Set<string> {
  const vars = new Set<string>()
  for (const m of Array.from(src.matchAll(/const\s+(\w+)\s*=\s*(?:await\s+)?createClient\(\)/g))) vars.add(m[1])
  if (/const\s*\{\s*supabase[^}]*\}\s*=\s*await\s+getSupabaseAndUser\(\)/.test(src)) vars.add('supabase')
  // a name rebound to the admin client in the same file is NOT caller-scoped
  for (const v of Array.from(vars)) {
    if (new RegExp(`const\\s+${v}\\s*=\\s*createAdminClient\\(\\)`).test(src)) vars.delete(v)
  }
  return vars
}

function findAccess(table: string, ops?: RegExp): Array<{ file: string; line: number }> {
  const hits: Array<{ file: string; line: number }> = []
  for (const file of walk('app').concat(walk('lib'), walk('components'))) {
    const src = readFileSync(file, 'utf8')
    for (const v of Array.from(browserClientVars(src))) {
      const re = new RegExp(`\\b${v}\\s*\\n?\\s*\\.from\\(\\s*['"]${table}['"]\\s*\\)((?:.|\\n){0,140})`, 'g')
      for (const m of Array.from(src.matchAll(re))) {
        if (ops && !ops.test(m[1])) continue
        hits.push({ file, line: src.slice(0, m.index).split('\n').length })
      }
    }
  }
  return hits
}

describe('A3: no browser client may touch the private profiles table', () => {
  it('zero caller-scoped reads of public.profiles remain anywhere', () => {
    const hits = findAccess('profiles')
    expect(hits.map((h) => `${h.file}:${h.line}`), 'migration 058 revoked this SELECT').toEqual([])
  })

  it('zero caller-scoped WRITES to intro_requests, matches, conversations or credit_transactions', () => {
    const write = /\.(insert|update|delete|upsert)\(/
    for (const t of ['intro_requests', 'matches', 'conversations', 'credit_transactions']) {
      const hits = findAccess(t, write)
      expect(hits.map((h) => `${h.file}:${h.line}`), `${t} DML is revoked by migration 055`).toEqual([])
    }
  })

  it('the server-authorized reader never offers select(*) and never restores browser access', () => {
    const src = readFileSync('lib/profiles/serverProfile.ts', 'utf8')
    const code = tsCode(src)          // the prose explains WHY there is no select('*'); check the code
    expect(code).toMatch(/createAdminClient/)
    expect(code).not.toMatch(/select\(\s*['"`]\*/)
    expect(code).not.toMatch(/GRANT|createClient\(\)/)
  })

  it('distinguishes a missing row from a read that did not answer', () => {
    const src = readFileSync('lib/profiles/serverProfile.ts', 'utf8')
    expect(src).toMatch(/if \(error\) \{/)
    expect(src).toMatch(/return \{ ok: false, reason: 'unavailable' \}/)
    expect(src).toMatch(/if \(!data\) return \{ ok: false, reason: 'not_found' \}/)
    // the defect being prevented: an error must never be reported as "not found"
    expect(src).toMatch(/NOT "not_found"/)
  })

  it('logs a class only — never an id, an email or a raw database message', () => {
    const src = readFileSync('lib/profiles/serverProfile.ts', 'utf8')
    for (const line of src.split('\n')) {
      if (!/console\.(log|warn|error)/.test(line)) continue
      // `${where}` is a static call-site label ('self-eligibility'), not member data. What must
      // never appear is an identifier or a raw driver message.
      const withoutLabel = line.replace(/\$\{where\}/g, 'LABEL')
      expect(withoutLabel).not.toMatch(/\$\{|\.message|email|user_id/)
    }
    expect(src).toMatch(/\?\.code \?\? 'unknown'/)
  })
})

describe('nomination: the nominator is resolved server-side, the nominee needs no account', () => {
  const SRC = readFileSync('app/api/referrals/submit/route.ts', 'utf8')

  it('resolves the nominator with the server-authorized reader, not the caller client', () => {
    expect(SRC).toMatch(/readSelfEligibility\(user\.id\)/)
    expect(SRC).not.toMatch(/supabase\s*\n?\s*\.from\('profiles'\)/)
  })

  it('separates unauthenticated, missing, inactive and unavailable — with distinct statuses', () => {
    expect(SRC).toMatch(/code: 'UNAUTHORIZED'[\s\S]{0,80}status: 401/)
    expect(SRC).toMatch(/code: 'PROFILE_NOT_FOUND'[\s\S]{0,80}status: 404/)
    expect(SRC).toMatch(/code: 'REFERRER_INACTIVE'[\s\S]{0,80}status: 403/)
    expect(SRC).toMatch(/code: 'PROFILE_UNAVAILABLE'[\s\S]{0,80}status: 503/)
  })

  it('a database failure is NEVER reported as "Profile not found"', () => {
    const unavailable = SRC.slice(SRC.indexOf("reason === 'unavailable'"), SRC.indexOf("reason === 'not_found'"))
    expect(unavailable).not.toMatch(/Profile not found/)
    expect(unavailable).toMatch(/could not verify your account/i)
  })

  it('the nominee is looked up with the admin client and may have no account', () => {
    // the existing external-nominee behaviour must survive the fix
    expect(SRC).toMatch(/adminClient\s*\n?\s*\.from\('profiles'\)/)
    expect(SRC).toMatch(/ilike\('email', targetEmail\)/)
  })

  it('leaks no raw database message to the member', () => {
    for (const m of Array.from(SRC.matchAll(/NextResponse\.json\(\s*\{[^}]*error:([^,}]*)/g))) {
      expect(m[1]).not.toMatch(/\.message|error\.details|error\.hint/)
    }
  })
})

describe('sibling routes no longer depend on the forbidden read', () => {
  const cases: Array<[string, RegExp]> = [
    ['app/api/stripe/checkout/route.ts', /readProfileById/],
    ['app/api/stripe/portal/route.ts', /readProfileById/],
    ['app/api/billing/check-credit-purchase/route.ts', /readProfileById/],
    ['app/api/intro-requests/express-interest/route.ts', /readProfileById/],
    ['app/actions.ts', /readProfileById|readProfilesByIds/],
    ['app/dashboard/admin/members/page.tsx', /createAdminClient\(\)/],
    ['components/AdminPendingBatches.tsx', /createAdminClient\(\)/],
  ]
  it.each(cases)('%s uses the server-authorized path', (file, expected) => {
    const src = readFileSync(file, 'utf8')
    expect(src).toMatch(expected)
    expect(src).not.toMatch(/supabase\s*\n?\s*\.from\('profiles'\)/)
  })

  it('stripe checkout fails the request rather than silently creating a duplicate customer', () => {
    const src = readFileSync('app/api/stripe/checkout/route.ts', 'utf8')
    const guard = src.slice(src.indexOf('const read = await readProfileById'), src.indexOf('const profile = read.profile'))
    expect(guard).toMatch(/if \(!read\.ok\)/)
    expect(guard).toMatch(/503/)
    // the failure that was happening: undefined customer id -> a brand new Stripe customer each time
    expect(src.indexOf('if (!read.ok)')).toBeLessThan(src.indexOf('stripe.customers.create'))
  })
})

describe('migration 072: chargeability is decided by participants, never by a caller flag', () => {
  const M072 = readFileSync('supabase/migrations/072_credit_debit_ledger_and_admin_exemption.sql', 'utf8')
  const BODY = () => M072.slice(M072.indexOf('AS $function$'), M072.indexOf('$function$;'))

  it('derives chargeability from profiles.is_admin, read under FOR SHARE', () => {
    expect(BODY()).toMatch(/FOR SHARE/)
    expect(BODY()).toMatch(/v_chargeable := \(v_admin_count = 0\)/)
    expect(BODY()).toMatch(/count\(\*\) FILTER \(WHERE pr\.is_admin IS TRUE\)/)
  })

  it('NEVER consults p_admin_facilitated when deciding whether to charge', () => {
    // comments explain that the flag is not consulted; the CODE must actually not consult it
    const body = sqlCode(BODY())
    const decision = body.slice(0, body.indexOf('IF v_chargeable THEN'))
    expect(decision).not.toMatch(/p_admin_facilitated/)
    // the flag survives in exactly one place: the match row it describes
    const uses = Array.from(body.matchAll(/p_admin_facilitated/g))
    expect(uses).toHaveLength(1)
    expect(body).toMatch(/VALUES \(p_user_a, p_user_b, p_admin_facilitated\)/)
  })

  it('hard-codes no administrator identity', () => {
    expect(M072).not.toMatch(/bizdev91|065d5d1a-2426-4e70-a89d-f9ceef99dee0/)
  })

  it('writes an attributable event for every participant, charged or exempt', () => {
    expect(BODY()).toMatch(/'match_debit:' \|\| v_match_id::text/)
    expect(BODY()).toMatch(/'match_exempt:' \|\| v_match_id::text/)
    expect(BODY()).toMatch(/INSERT INTO public\.credit_transactions/)
  })

  it('keeps the ledger append-only and idempotent', () => {
    expect(M072).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_event_key_uniq/)
    expect(M072).toMatch(/WHERE event_key IS NOT NULL/)      // partial: legacy rows cannot conflict
    expect(M072).toMatch(/append-only and cannot be deleted/)
    expect(M072).toMatch(/append-only and cannot be modified/)
  })

  it('preserves the audited spend rule and balance expression verbatim', () => {
    const recalcs = BODY().match(/balance = \(free_credits - 1\) \+ COALESCE\(premium_credits, 0\)/g) ?? []
    expect(recalcs).toHaveLength(2)
    expect(BODY()).toMatch(/free_credits >= 1/)              // free-credit-only spend, unchanged
    expect(M072).toMatch(/FOLLOWUP_FREE_CREDIT_ONLY_SPEND\.md/)
  })

  it('does not restore service_role EXECUTE on the delegate that 068 removed', () => {
    const code = M072.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(code).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.consume_credits_and_create_match/)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.consume_credits_and_create_match\(uuid, uuid, boolean\) FROM PUBLIC/)
  })

  it('keeps the hardened function posture', () => {
    expect(M072).toMatch(/SECURITY DEFINER\nSET search_path = ''/)
    expect(M072).toMatch(/RETURNS TABLE \(match_id uuid, conversation_id uuid, error_code text\)/)
    const body = BODY().split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(body.replace(/public\.(meeting_credits|matches|conversations|credit_transactions|profiles)/g, ''))
      .not.toMatch(/\b(meeting_credits|matches|conversations|credit_transactions|profiles)\b/)
  })

  it('migrations 063-071 are untouched by this work', () => {
    for (const f of ['069_delivery_purposes_and_event_key', '070_introduction_email_outbox',
                     '071_outbox_service_role_least_privilege']) {
      expect(readFileSync(`supabase/migrations/${f}.sql`, 'utf8').length).toBeGreaterThan(0)
    }
    expect(M072).toMatch(/Migrations 063-071 are untouched/)
  })
})

/**
 * BLOCKER 1: migration 072 cannot be called THE atomic credit authority while other deployed routes
 * independently move balances. This pins the disposition of every remaining credit writer.
 *
 * The stored invariant, everywhere: balance = COALESCE(free_credits,0) + COALESCE(premium_credits,0)
 */
describe('every credit writer is contained', () => {
  const FACILITATE = readFileSync('app/api/admin/facilitate-intro/route.ts', 'utf8')
  const ACTIONS = readFileSync('app/actions.ts', 'utf8')
  const TARGETED = readFileSync('app/api/targeted-request/submit/route.ts', 'utf8')

  it('no route decrements balance ALONE any more', () => {
    // the facilitate-intro signature: `balance: balance - 1` with free_credits untouched
    for (const [name, src] of [['facilitate-intro', FACILITATE], ['actions', ACTIONS], ['targeted', TARGETED]] as const) {
      const code = tsCode(src)
      const balanceOnly = /update\(\s*\{\s*balance:[^}]*\}\s*\)/g
      for (const m of Array.from(code.matchAll(balanceOnly))) {
        expect(m[0], `${name} updates balance without recomputing it`).toMatch(/free_credits|premium_credits/)
      }
    }
  })

  it('facilitate-intro is FAIL-CLOSED pending the product decision, and writes nothing', () => {
    expect(FACILITATE).toMatch(/const FACILITATION_ENABLED = false as boolean/)
    expect(FACILITATE).toMatch(/FACILITATION_DISABLED_PENDING_POLICY/)
    expect(FACILITATE).toMatch(/status: 501/)
    // The credit mutations are GONE, not merely gated — re-enabling must not be one boolean away
    // from a balance-only decrement.
    expect(FACILITATE).not.toMatch(/from\('meeting_credits'\)\s*\n?\s*\.update/)
    expect(FACILITATE).not.toMatch(/from\('credit_transactions'\)/)
    // Anything that DOES remain must sit behind the guard.
    const guard = FACILITATE.indexOf('if (!FACILITATION_ENABLED)')
    for (const write of ["from('matches')", "from('conversations')"]) {
      const at = FACILITATE.indexOf(write)
      if (at !== -1) expect(guard, `guard must precede ${write}`).toBeLessThan(at)
    }
  })

  it('facilitate-intro states the ambiguity rather than picking a policy', () => {
    expect(FACILITATE).toMatch(/free, charged to one, or\n\s*\/\/ charged to both/)
    expect(FACILITATE).toMatch(/choosing here would be inventing policy/)
  })

  it('the admin credit adjustment cannot write a negative or non-additive balance', () => {
    const fn = ACTIONS.slice(ACTIONS.indexOf('// Update credits if provided'),
                             ACTIONS.indexOf('// Update credits if provided') + 2600)
    expect(fn).toMatch(/if \(!Number\.isInteger\(next\) \|\| next < 0\)/)   // no negative
    expect(fn).toMatch(/balance: next \+ premium/)                          // recomputed, not assumed
    expect(fn).toMatch(/free_credits: next/)                                // sets a real bucket
    expect(fn).not.toMatch(/upsert\(\{\s*\n\s*user_id: userId,\s*\n\s*balance: updates\.credits/)
  })

  it('the admin adjustment leaves an attributable, append-only event', () => {
    const fn = ACTIONS.slice(ACTIONS.indexOf('// Update credits if provided'),
                             ACTIONS.indexOf('// Update credits if provided') + 2600)
    expect(fn).toMatch(/event_key: `admin_adjust:\$\{randomUUID\(\)\}`/)
    expect(fn).toMatch(/source_kind: 'admin_adjustment'/)
    expect(fn).toMatch(/amount: delta/)
  })

  it('the admin adjustment no longer leaks a raw database message', () => {
    const fn = ACTIONS.slice(ACTIONS.indexOf('// Update credits if provided'),
                             ACTIONS.indexOf('// Update credits if provided') + 2600)
    expect(fn).not.toMatch(/error: error\.message/)
  })

  it('the targeted-request premium debit is race-guarded and ledgered', () => {
    expect(TARGETED).toMatch(/\.gte\('premium_credits', 1\)/)   // cannot both read 1 and both write 0
    expect(TARGETED).toMatch(/balance: currentFree \+ newPremium/)
    expect(TARGETED).toMatch(/event_key: `targeted_request:\$\{targetedRequest\.id\}`/)
    expect(TARGETED).toMatch(/source_kind: 'targeted_request_debit'/)
  })

  it('only ONE SQL function may move meeting_credits', () => {
    const M072 = readFileSync('supabase/migrations/072_credit_debit_ledger_and_admin_exemption.sql', 'utf8')
    // both updates live in the delegate, and nowhere else in the migration
    expect((sqlCode(M072).match(/UPDATE public\.meeting_credits/g) ?? [])).toHaveLength(2)
  })
})

describe('the corrected refund populations', () => {
  const RECON = readFileSync('supabase/audits/credit_debit_reconciliation.sql', 'utf8')

  it('classifies an administrator from their OWN side, not the counterpart test', () => {
    // "counterpart is an admin" is meaningless for the admin; it routed their real deductions to
    // manual review. self_is_admin is what fixes that.
    expect(RECON).toMatch(/self_is_admin/)
    expect(RECON).toMatch(/m\.other_is_admin OR m\.self_is_admin/)
    expect(RECON).toMatch(/PERSPECTIVE FIX/)
  })

  it('reports the five required populations distinctly', () => {
    for (const pop of ['1_member_charged_for_admin_connection', '2_admin_operational_deduction',
                       '3_legitimate_missing_record', '4_ambiguous_manual_review',
                       '5_inconsistent_balance_state']) {
      expect(RECON, pop).toContain(pop)
    }
  })

  it('separates test and deactivated accounts instead of mixing them into recovery', () => {
    expect(RECON).toMatch(/account_class/)
    expect(RECON).toMatch(/'test_account'/)
    expect(RECON).toMatch(/'inactive_or_deactivated'/)
    expect(RECON).toMatch(/Never email, never reactivate/)
  })

  it('routes a negative balance to inconsistent state, never to a refund', () => {
    expect(RECON).toMatch(/r\.balance < 0 OR r\.free_credits < 0 OR r\.premium_credits < 0\n\s*THEN '5_inconsistent_balance_state'/)
  })

  it('checks all four stored-state integrity conditions', () => {
    for (const k of ['balance BELOW ZERO', 'free_credits BELOW ZERO', 'premium_credits BELOW ZERO',
                     'balance <> free + premium']) {
      expect(RECON).toContain(k)
    }
  })

  it('still refuses to refund on a missing ledger row alone', () => {
    expect(RECON).toMatch(/DO NOT REFUND/)
    expect(RECON).toMatch(/ABSENCE OF A LEDGER ROW IS NOT EVIDENCE/)
  })

  it('freezes no expected count into the query', () => {
    expect(RECON).not.toMatch(/\b49\b|\b54\b|\b47\b/)
  })
})

describe('the recovery artifact stays non-executable', () => {
  const REC = readFileSync('supabase/audits/RECOVERY_credit_refund_2026_08_21.sql.PROPOSED', 'utf8')
  it('ends in ROLLBACK with COMMIT commented out and an empty manifest', () => {
    expect(REC.trim().endsWith('ROLLBACK;')).toBe(true)
    expect(REC).toMatch(/^-- COMMIT;/m)
    expect(REC).not.toMatch(/^INSERT INTO recovery_manifest/m)
    expect(REC).toMatch(/v_expected_rows\s+integer := -1/)
  })
  it('is not in Downloads and is not a .sql file', () => {
    expect(REC.length).toBeGreaterThan(0)
    expect('supabase/audits/RECOVERY_credit_refund_2026_08_21.sql.PROPOSED').toMatch(/\.PROPOSED$/)
  })
})

/**
 * MIGRATION 073. Migration 072's narrow REVOKE could not remove privileges it did not name, and
 * this out-of-band table had inherited more from Supabase's default grants than 072 listed —
 * the same defect class as 071 for the outbox. A GRANT is additive; only REVOKE ALL is not.
 */
describe('migration 073: the credit_transactions ACL contract', () => {
  const M073 = readFileSync('supabase/migrations/073_credit_transactions_acl_correction.sql', 'utf8')
  const POST = readFileSync('supabase/audits/postapply_072_073.sql', 'utf8')

  it('REVOKEs ALL before granting anything back', () => {
    const code = sqlCode(M073)
    expect(code).toMatch(/REVOKE ALL\nON TABLE public\.credit_transactions\nFROM PUBLIC, anon;/)
    expect(code).toMatch(/REVOKE ALL\nON TABLE public\.credit_transactions\nFROM service_role;/)
    expect(code.indexOf('FROM service_role;')).toBeLessThan(code.indexOf('TO service_role;'))
  })

  it('grants service_role exactly SELECT and INSERT — the ledger is append-only', () => {
    const grants = sqlCode(M073).match(/GRANT[^;]+;/g) ?? []
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatch(/GRANT SELECT, INSERT/)
    expect(grants[0]).not.toMatch(/UPDATE|DELETE|TRUNCATE|ALL/)
  })

  it('strips every mutation verb from authenticated but keeps its read', () => {
    const code = sqlCode(M073)
    expect(code).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER\nON TABLE public\.credit_transactions\nFROM authenticated;/)
    // SELECT is deliberately NOT revoked from authenticated
    expect(code).not.toMatch(/REVOKE[^;]*SELECT[^;]*FROM authenticated/)
  })

  it('self-verifies all three roles and refuses a mismatch', () => {
    for (const msg of ['anon retains an unexpected credit_transactions privilege',
                       'authenticated retains a credit_transactions mutation privilege',
                       'service_role credit_transactions privileges do not match the required contract']) {
      expect(M073).toContain(msg)
    }
    expect(M073).toMatch(/DO \$\$/)
  })

  it('explains the inherited-grant cause and does not touch 063-072', () => {
    expect(M073).toMatch(/A GRANT IS\n-- ADDITIVE/)
    expect(M073).toMatch(/ALTER DEFAULT PRIVILEGES/)
    expect(M073).toMatch(/Migrations 063-072 are untouched/)
    expect(sqlCode(M073)).not.toMatch(/consume_credits_and_create_match|DROP|ALTER TABLE/)
  })

  it('migration 072 remains byte-for-byte the applied artifact', () => {
    expect(createHash('sha256').update(readFileSync('supabase/migrations/072_credit_debit_ledger_and_admin_exemption.sql')).digest('hex'))
      .toBe('42375399c440de8d2587d6eaaeb774560127a8a720bfbd9e6ccd6108f756a4b7')
  })

  it('the post-apply artifact asserts each ACL verb separately', () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const verb of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        expect(POST, `${role}/${verb}`).toMatch(new RegExp(`'${role}','public\\.credit_transactions','${verb}'`))
      }
    }
    expect(POST).toMatch(/direct grants to PUBLIC in the ACL/)
  })

  it('does NOT blame 072 for state that predates it, but still catches a post-072 regression', () => {
    // historical inconsistency is context...
    expect(POST).toMatch(/negative balance \(pre-072\)[\s\S]{0,500}'context'/)
    expect(POST).toMatch(/migration 072 is PROSPECTIVE containment/)
    // ...while an account debited BY the new authority must still be sound
    expect(POST).toMatch(/accounts debited post-072 with a negative bucket[\s\S]{0,400}'0'\)/)
    expect(POST).toMatch(/c\.source_kind = 'match_debit'/)
  })
})
