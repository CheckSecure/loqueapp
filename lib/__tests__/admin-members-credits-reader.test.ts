import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// CREDIT RELEASE 1A — the admin Members credit reader.
//
// SELF-CONTAINED BY DESIGN. This file reads exactly ONE source file, the one Release 1A ships.
// It deliberately does not reference the Release 1 migrations, audits, repair artifact, the
// admin_adjust_credits RPC, or app/actions.ts — none of those are in this commit, and a test that
// inspected them would pass here and fail on a clean checkout of this tree.
//
// WHY THIS CHANGE SHIPS ALONE, AND FIRST. Migration 087 will put an own-row-only RLS policy on
// public.meeting_credits. The read below has NO user_id filter — it is the whole table — so under
// that policy a cookie-session client would return only the administrator's own row and every
// other member's credit column would silently read 0. Moving it to the service-role client first
// makes the page correct both before and after the migration.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const PATH = 'app/dashboard/admin/members/page.tsx'
const RAW = readFileSync(PATH, 'utf8')
/** Executable source: the file explains the shapes it avoids, so probes must not read comments. */
const SRC = RAW.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ')

describe('admin Members credits reader (Release 1A)', () => {
  it('reads the whole meeting_credits table via createAdminClient()', () => {
    expect(SRC).toMatch(/const creditsClient = createAdminClient\(\)/)
    expect(SRC).toMatch(/creditsClient\s*\n?\s*\.from\('meeting_credits'\)/)
  })

  it('no cookie-session client reads meeting_credits on this page', () => {
    const sessionVars = new Set<string>()
    const re = /(?:const|let)\s+(\w+)\s*=\s*createClient\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(SRC)) !== null) sessionVars.add(m[1])
    const use = /(?:^|[^\w.])([A-Za-z_$][\w$]*)\s*\n?\s*\.from\('meeting_credits'\)/g
    let u: RegExpExecArray | null
    while ((u = use.exec(SRC)) !== null) {
      expect(sessionVars.has(u[1]), `${u[1]}.from('meeting_credits') uses the session client`).toBe(false)
    }
  })

  it('the read is reached only AFTER the admin gate', () => {
    expect(SRC).toMatch(/if \(!user \|\| user\.email !== ADMIN_EMAIL\) redirect\('\/dashboard'\)/)
    const gate = SRC.indexOf('user.email !== ADMIN_EMAIL')
    const read = SRC.indexOf('creditsClient')
    expect(gate).toBeGreaterThan(-1)
    expect(read).toBeGreaterThan(gate)
  })

  it('authority still comes from the verified session, not from the client', () => {
    // the session client is still constructed and still performs authentication
    expect(SRC).toMatch(/const supabase = createClient\(\)/)
    expect(SRC).toMatch(/supabase\.auth\.getUser\(\)/)
  })

  it('the selected columns are unchanged — no widening', () => {
    const i = SRC.indexOf("from('meeting_credits')")
    expect(SRC.slice(i, i + 120)).toContain("select('user_id, balance')")
    for (const c of ['free_credits', 'premium_credits', 'lifetime_earned'])
      expect(SRC.slice(i, i + 200), c).not.toContain(c)
  })

  it('no write behaviour was introduced on this page', () => {
    expect(SRC).not.toMatch(/\.from\('meeting_credits'\)\s*\n?\s*\.(update|insert|upsert|delete)\(/)
    // and the page performs no credit write of any kind
    const writes = SRC.match(/\.(update|insert|upsert|delete)\(/g) || []
    expect(writes).toEqual([])
  })

  it('logs no member identity, credit value or service-role secret', () => {
    // strip string literals so a log MESSAGE mentioning "Credits" is not mistaken for logging data
    const noStrings = SRC.replace(/'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"/g, "''")
    const re = /console\.(log|error|warn)\(([^\n]*)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(noStrings)) !== null) {
      // a COUNT is fine; the rows, ids, emails and balances are not
      const arg = m[2].replace(/\??\.length/g, '.LEN')
      expect(arg, m[0]).not.toMatch(
        /\b(credits|creditsMap|profiles|enrichedProfiles|matches|intros|balance|email|user_id)\b(?!\.LEN)/)
      expect(arg, m[0]).not.toMatch(/SERVICE_ROLE|service_role|access_token|SUPABASE_/)
    }
  })

  it('is self-contained: it names no file outside Release 1A', () => {
    const self = readFileSync('lib/__tests__/admin-members-credits-reader.test.ts', 'utf8')
    // Every repo-path-shaped string literal in this file, however it reaches readFileSync.
    const re = /'((?:app|lib|components|supabase)\/[^']+)'/g
    const paths: string[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(self)) !== null) paths.push(m[1])
    // Array.from, not a spread: spreading a Set needs downlevelIteration in this tsconfig.
    const unique = Array.from(new Set(paths)).sort()
    expect(unique).toEqual([PATH, 'lib/__tests__/admin-members-credits-reader.test.ts'].sort())
    // Nothing excluded from this commit may be referenced. The needles are assembled from
    // fragments so they are not themselves path-shaped literals — otherwise this very check
    // would trip the scan above.
    const forbidden = ['supabase' + '/migrations', 'supabase' + '/audits', 'supabase' + '/repairs',
                       'app' + '/actions.ts', 'admin' + '_adjust_credits', 'credit' + '-release-1']
    // Executable code only. The header above NAMES these in order to say it does not depend on
    // them; prose describing an excluded file is not a dependency on it.
    const selfCode = self.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ')
    for (const f of forbidden) expect(selfCode, f).not.toContain(f)
  })
})
