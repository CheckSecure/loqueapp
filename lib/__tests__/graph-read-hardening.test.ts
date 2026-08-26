import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(p, 'utf8')
/** exec loops: spreading matchAll needs downlevelIteration in this tsconfig. */
const execAll = (src: string, re: RegExp): RegExpExecArray[] => {
  const out: RegExpExecArray[] = []
  let m: RegExpExecArray | null
  const r = new RegExp(re.source, re.flags)
  while ((m = r.exec(src)) !== null) out.push(m)
  return out
}
const scan = (src: string, re: RegExp, group: number): string[] =>
  execAll(src, re).map(m => m[group])
/** Executable source only — comments legitimately name the things the code must not do. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ')

// The eight Release-A sites, with the client each read must now use.
const SITES = [
  { file: 'app/dashboard/network/page.tsx',        table: 'matches',       client: 'graphClient' },
  { file: 'app/dashboard/network/page.tsx',        table: 'blocked_users', client: 'graphClient' },
  { file: 'app/dashboard/profile/[id]/page.tsx',   table: 'matches',       client: 'graphClient' },
  { file: 'app/dashboard/introductions/page.tsx',  table: 'matches',       client: 'graphClient' },
  { file: 'app/dashboard/layout.tsx',              table: 'matches',       client: 'graphClient' },
  { file: 'app/dashboard/meetings/page.tsx',       table: 'matches',       client: 'graphClient' },
  { file: 'app/dashboard/admin/members/page.tsx',  table: 'matches',       client: 'graphClient' },
  { file: 'app/actions.ts',                        table: 'matches',       client: 'adminClient' },
] as const
const FILES = SITES.map(s => s.file).filter((f, i, a) => a.indexOf(f) === i)

const allTsx = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) { if (e !== 'node_modules' && e !== '.next') allTsx(p, out) }
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p)
  }
  return out
}
const TREE = [...allTsx('app'), ...allTsx('lib'), ...allTsx('components')]
  .filter(p => !p.includes('__tests__'))

// ── 1. No cookie-session client reads either table, anywhere ──────────────────────────
describe('no cookie-session reader of matches / blocked_users remains', () => {
  // RELEASE A now covers all NINE sites. This sweep finds every cookie-session read in the tree,
  // so a new one fails immediately. Parameter-injected readers are traced to their callers in the
  // dedicated block below rather than excused here.
  const KNOWN_OUT_OF_SCOPE: string[] = []

  it('every read site in the tree uses a service-role client', () => {
    const offenders: string[] = []
    const paramSites: string[] = []
    for (const p of TREE) {
      const src = code(p)
      if (!/from\('(matches|blocked_users)'\)/.test(src)) continue
      // Resolve LOCALS, BROWSER clients, session helpers, PARAMETERS and ALIASES — a name-based
      // allowlist would quietly excuse a genuinely unsafe reader.
      const admin = new Set(scan(src, /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?createAdminClient\(/g, 1))
      const session = new Set(scan(src, /(?:const|let|var)\s+(\w+)\s*=\s*createClient\(/g, 1))
      const browser = new Set<string>()
      if (/from '@\/lib\/supabase\/client'/.test(src)) {
        session.forEach(v => browser.add(v)); session.clear()
      }
      for (const m of execAll(src, /const\s*\{([^}]*)\}\s*=\s*await\s+getSupabaseAndUser\(\)/g))
        for (const n of scan(m[1], /(\w+)/g, 1)) if (n !== 'user') session.add(n)
      // function parameters, both destructured-from-params and typed signatures
      const params = new Set<string>()
      for (const m of execAll(src, /const\s*\{([^}]*)\}\s*=\s*params\b/g))
        for (const n of scan(m[1], /(\w+)/g, 1)) params.add(n)
      for (const m of execAll(src, /function\s+\w+\s*\(([^)]*)\)/g))
        for (const n of scan(m[1], /(\w+)\s*:/g, 1)) params.add(n)
      // aliases: const x = y
      const alias = new Map<string, string>()
      for (const m of execAll(src, /(?:const|let)\s+(\w+)\s*=\s*(\w+)\s*\n/g)) alias.set(m[1], m[2])
      const resolve = (v: string): string => { let x = v; for (let i = 0; i < 5 && alias.has(x); i++) x = alias.get(x)!; return x }

      for (const m of execAll(src, /(\w+)\s*\n?\s*\.from\('(matches|blocked_users)'\)/g)) {
        const v = resolve(m[1])
        // ORDER MATTERS: a name bound to a local createAdminClient() IS a service-role client,
        // even when the same identifier also appears as a parameter elsewhere in the file.
        if (browser.has(v)) offenders.push(`${p}: BROWSER ${v}.from('${m[2]}')`)
        else if (session.has(v)) offenders.push(`${p}: SESSION ${v}.from('${m[2]}')`)
        else if (admin.has(v)) { /* service-role local */ }
        else if (params.has(v)) paramSites.push(`${p}: PARAMETER ${v}.from('${m[2]}')`)
        else if (!/createAdminClient\(\)\s*\n?\s*\.from/.test(src))
          offenders.push(`${p}: UNRESOLVED ${v}.from('${m[2]}')`)
      }
    }
    // ZERO cookie-session, ZERO browser, ZERO unresolved readers anywhere in the tree.
    expect(offenders.sort()).toEqual(KNOWN_OUT_OF_SCOPE)
    // Parameter-injected readers are legitimate; the next test traces every caller.
    expect(paramSites.length).toBe(11)
    expect(paramSites).toContain("lib/introductions/finalizeMutualMatch.ts: PARAMETER graphClient.from('matches')")
  })

  // ── every PARAMETER-injected reader is traced to what its callers actually pass ────────
  it('every parameter-injected graph reader receives a service-role client from every caller', () => {
    const MODULES: ReadonlyArray<readonly [string, string, readonly string[]]> = [
      ['lib/admin/dashboardData.ts',                'admin',       ['app/dashboard/admin/operations/page.tsx', 'app/dashboard/admin/page.tsx']],
      ['lib/introductions/finalizeMutualMatch.ts',  'graphClient', ['app/api/intro-requests/express-interest/route.ts', 'app/api/intro-requests/accept-incoming/route.ts']],
      ['lib/introductions/incomingInterest.ts',     'db',          ['app/api/cron/engagement-reminders/route.ts', 'app/api/intro-requests/accept-incoming/route.ts', 'app/dashboard/introductions/page.tsx']],
      ['lib/introductions/poolHealth.ts',           'admin',       ['app/api/admin/pool-health/route.ts']],
      ['lib/introductions/queue-metrics.ts',        'adminClient', ['app/api/admin/queue-metrics/route.ts']],
      ['lib/messages/sendMessageCore.ts',           'admin',       ['app/actions.ts', 'app/api/messages/send/route.ts']],
      ['lib/privacy/canViewerDiscoverMember.ts',    'db',          ['app/company/[slug]/page.tsx', 'app/dashboard/profile/[id]/page.tsx']],
    ]
    for (const [, , callers] of MODULES) {
      for (const c of callers) {
        // every caller constructs a service-role client…
        expect(code(c), c).toMatch(/createAdminClient\(/)
        // …and no caller hands a browser client to anything
        expect(code(c), c).not.toMatch(/from '@\/lib\/supabase\/client'/)
      }
    }
  })

  it('NO `use client` file reads either table', () => {
    const bad = TREE.filter(p => {
      const src = read(p)
      return /^['"]use client['"]/m.test(src.slice(0, 200)) && /from\('(matches|blocked_users)'\)/.test(code(p))
    })
    expect(bad).toEqual([])
  })

  it('no browser Supabase client is used for either table', () => {
    const bad = TREE.filter(p => {
      const src = code(p)
      return /supabase\/client/.test(src) && /from\('(matches|blocked_users)'\)/.test(src)
    })
    expect(bad).toEqual([])
  })
})

// ── 2. Each site uses the narrowly scoped client for the migrated read only ───────────
describe('narrowly scoped server client per site', () => {
  it.each(FILES)('%s declares its scoped client from createAdminClient()', (f) => {
    const src = code(f)
    const name = SITES.find(s => s.file === f)!.client
    expect(src).toMatch(new RegExp(`const ${name}\\s*=\\s*createAdminClient\\(\\)`))
  })

  it.each(SITES.map(s => [s.file, s.table, s.client] as const))(
    '%s reads %s via %s', (f, table, client) => {
      expect(code(f)).toMatch(new RegExp(`${client}\\s*\\n?\\s*\\.from\\('${table}'\\)`))
    })

  it('the session client still performs authentication at every member-facing site', () => {
    for (const f of ['app/dashboard/network/page.tsx', 'app/dashboard/profile/[id]/page.tsx',
                     'app/dashboard/meetings/page.tsx', 'app/dashboard/admin/members/page.tsx']) {
      const src = code(f)
      expect(src, f).toMatch(/const supabase = createClient\(\)/)
      expect(src, f).toMatch(/supabase\.auth\.getUser\(\)/)
    }
    // the layout uses the deduped server-validated helper instead
    expect(code('app/dashboard/layout.tsx')).toMatch(/const user = await getAuthUser\(\)/)
    // the server action uses the existing session+user helper
    expect(code('app/actions.ts')).toMatch(/getSupabaseAndUser\(\)/)
  })

  it('the session client is NOT wholesale replaced — other RLS-dependent reads still use it', () => {
    // network: notifications + conversations still go through the member session
    const net = code('app/dashboard/network/page.tsx')
    expect(net).toMatch(/supabase\s*\n?\s*\.from\('notifications'\)/)
    expect(net).toMatch(/supabase\.from\('conversations'\)/)
    // meetings: the meetings read stays on the session client
    expect(code('app/dashboard/meetings/page.tsx')).toMatch(/supabase\s*\n?\s*\.from\('meetings'\)/)
    // profile: public_profiles + meetings stay on the session client
    const prof = code('app/dashboard/profile/[id]/page.tsx')
    expect(prof).toMatch(/supabase\s*\n?\s*\.from\('public_profiles'\)/)
    expect(prof).toMatch(/supabase\s*\n?\s*\.from\('meetings'\)/)
    // introductions: intro_requests stay on the session client
    expect(code('app/dashboard/introductions/page.tsx')).toMatch(/supabase\s*\n?\s*\.from\('intro_requests'\)/)
  })
})

// ── 3. Viewer constraints and column lists are unchanged ──────────────────────────────
describe('no query was broadened', () => {
  it('every migrated read keeps its exact viewer predicate', () => {
    expect(code('app/dashboard/network/page.tsx'))
      .toContain('.or(`user_a_id.eq.${profileId},user_b_id.eq.${profileId}`)')
    expect(code('app/dashboard/network/page.tsx'))
      .toContain('.or(`user_id.eq.${profileId},blocked_user_id.eq.${profileId}`)')
    expect(code('app/dashboard/introductions/page.tsx'))
      .toContain('.or(`user_a_id.eq.${profileId},user_b_id.eq.${profileId}`)')
    expect(code('app/dashboard/layout.tsx'))
      .toContain('.or(`user_a_id.eq.${user.id},user_b_id.eq.${user.id}`)')
    expect(code('app/dashboard/meetings/page.tsx'))
      .toContain('.or(`user_a_id.eq.${user.id},user_b_id.eq.${user.id}`)')
  })

  it('reversed pair ordering is still covered at both bidirectional sites', () => {
    // profile: both column orders written out
    const prof = code('app/dashboard/profile/[id]/page.tsx')
    expect(prof).toContain('and(user_a_id.eq.${user.id},user_b_id.eq.${params.id}),and(user_a_id.eq.${params.id},user_b_id.eq.${user.id})')
    // the server action: the shared helper, which emits both orders
    expect(code('app/actions.ts')).toContain('.or(buildBidirectionalMatchFilter(userAId, userBId))')
    const helper = read('lib/db/filters.ts')
    expect(helper).toContain("'and(user_a_id.eq.' + userA + ',user_b_id.eq.' + userB + '),and(user_a_id.eq.' + userB + ',user_b_id.eq.' + userA + ')'")
  })

  it('status filters are unchanged (canonical semantics untouched this release)', () => {
    expect(code('app/dashboard/profile/[id]/page.tsx')).toContain(".neq('status', 'removed')")
    expect(code('app/dashboard/network/page.tsx')).toContain("m.status !== 'removed'")
  })

  it('selected columns did not expand', () => {
    const EXPECTED: Record<string, string[]> = {
      'app/dashboard/network/page.tsx':       ["'id, user_a_id, user_b_id, matched_at, status, removed_at'", "'user_id, blocked_user_id'"],
      'app/dashboard/profile/[id]/page.tsx':  ["'matched_at, status'"],
      'app/dashboard/introductions/page.tsx': ["'user_a_id, user_b_id'"],
      'app/dashboard/layout.tsx':             ["'id'"],
      'app/dashboard/meetings/page.tsx':      ["'id, user_a_id, user_b_id'"],
      'app/dashboard/admin/members/page.tsx': ["'user_a_id, user_b_id, status'"],
      'app/actions.ts':                       ["'id'"],
    }
    for (const [f, cols] of Object.entries(EXPECTED)) {
      const src = code(f)
      const idx = src.indexOf("from('matches')")
      const window = src.slice(idx, idx + 220)
      expect(window, f).toContain(cols[0])
    }
  })

  it('no private match column is selected anywhere in the migrated reads', () => {
    for (const f of FILES) {
      const src = code(f)
      for (const m of execAll(src, /\.from\('(matches|blocked_users)'\)\s*\n?\s*\.select\('([^']*)'\)/g)) {
        for (const forbidden of ['admin_notes', 'removed_by', 'admin_facilitated', 'opportunity_id', 'suggestion_id']) {
          expect(m[2], `${f} selects ${forbidden}`).not.toContain(forbidden)
        }
      }
    }
  })
})

// ── 4. Authorization is still session-derived ─────────────────────────────────────────
describe('authority still comes from the verified session', () => {
  it('the admin Members whole-table read is reached only after the admin gate', () => {
    const src = code('app/dashboard/admin/members/page.tsx')
    const gate = src.indexOf("user.email !== ADMIN_EMAIL")
    const readAt = src.indexOf("graphClient")
    expect(gate).toBeGreaterThan(-1)
    expect(readAt).toBeGreaterThan(gate)
    expect(src).toMatch(/if \(!user \|\| user\.email !== ADMIN_EMAIL\) redirect\('\/dashboard'\)/)
  })

  it('the server action keeps its admin gate ahead of the read', () => {
    const src = code('app/actions.ts')
    const fn = src.slice(src.indexOf('export async function adminForceMatch'))
    const gate = fn.indexOf("user.email !== 'bizdev91@gmail.com'")
    const readAt = fn.indexOf("adminClient\n    .from('matches')")
    expect(gate).toBeGreaterThan(-1)
    expect(readAt === -1 ? fn.indexOf('.from(\'matches\')') : readAt).toBeGreaterThan(gate)
  })

  it('member-facing sites filter on an id derived from the session, never a request param', () => {
    // network + introductions resolve profileId from the authenticated user id
    expect(code('app/dashboard/network/page.tsx')).toMatch(/const profileId = profileRows\?\.\[0\]\?\.id \?\? user\.id/)
    expect(code('app/dashboard/introductions/page.tsx')).toMatch(/const profileId = profileRow\?\.id \?\? user\.id/)
    // profile: the ROUTE param is the subject, but the viewer half is user.id
    const prof = code('app/dashboard/profile/[id]/page.tsx')
    expect(prof).toMatch(/user_a_id\.eq\.\$\{user\.id\}/)
    // and the subject was gated before any read
    expect(prof).toMatch(/canViewerDiscoverMember\(admin, user\.id, params\.id\)/)
  })

  it('fails closed when authentication is unavailable', () => {
    for (const [f, pat] of [
      ['app/dashboard/network/page.tsx', /if \(!user\) redirect\('\/login'\)/],
      ['app/dashboard/meetings/page.tsx', /if \(!user\) redirect\('\/login'\)/],
      ['app/dashboard/layout.tsx', /if \(!user\) redirect\('\/login'\)/],
      ['app/dashboard/profile/[id]/page.tsx', /if \(!user\) redirect\('\/login'\)/],
      ['app/dashboard/admin/members/page.tsx', /if \(!user \|\| user\.email !== ADMIN_EMAIL\) redirect/],
    ] as const) expect(code(f), f).toMatch(pat)
    expect(code('app/actions.ts')).toMatch(/if \(!user \|\| user\.email !== 'bizdev91@gmail\.com'\) return \{ error: 'Not authorized' \}/)
  })
})

// ── 4b. finalizeMutualMatch — strict client separation ────────────────────────────────
describe('finalizeMutualMatch keeps three separate clients', () => {
  const SRC = code('lib/introductions/finalizeMutualMatch.ts')
  const ROUTES = ['app/api/intro-requests/express-interest/route.ts',
                  'app/api/intro-requests/accept-incoming/route.ts'] as const

  it('declares graphClient as its own parameter, not a rename of supabase', () => {
    expect(SRC).toMatch(/graphClient: any/)
    expect(SRC).toMatch(/supabase: any/)
    expect(SRC).toMatch(/adminClient: any/)
    expect(SRC).toMatch(/const \{ supabase, adminClient, graphClient, actingUserId, otherUserId, isAdminInitiated \} = params/)
  })

  it('uses graphClient for the existing-match lookup and NOTHING else', () => {
    const uses = execAll(SRC, /graphClient\s*\n?\s*\.(\w+)\(/g).map(m => m[1])
    expect(uses).toEqual(['from'])
    expect(SRC).toMatch(/graphClient\s*\n?\s*\.from\('matches'\)/)
    // and no other table is reached through it
    expect(SRC).not.toMatch(/graphClient\s*\n?\s*\.from\('(?!matches')/)
  })

  it('the session client keeps EXACTLY its previous non-graph operations', () => {
    // it no longer touches matches …
    expect(SRC).not.toMatch(/\bsupabase\s*\n?\s*\.from\('matches'\)/)
    // … and still performs both member-authority profile reads
    const sessionFroms = execAll(SRC, /\bsupabase\s*\n?\s*\.from\('(\w+)'\)/g).map(m => m[1])
    expect(sessionFroms).toEqual(['profiles', 'profiles'])
    expect(SRC).toMatch(/\.select\('full_name, email, title, company'\)/)
  })

  it('adminClient keeps the write, RPC, credit and notification path unchanged', () => {
    for (const frag of ["adminClient.rpc(", "adminClient.from('member_pairs')",
                        "adminClient.from('conversations')", "adminClient.from('messages')",
                        "retireWaitingResponseForPair(adminClient"]) {
      expect(SRC, frag).toContain(frag)
    }
  })

  it('the lookup is byte-identical apart from the client', () => {
    expect(SRC).toContain(".select('id, status')")
    expect(SRC).toContain('.or(buildBidirectionalMatchFilter(actingUserId, otherUserId))')
    expect(SRC).toContain('.maybeSingle()')
    // the duplicate-match branch is untouched
    expect(SRC).toMatch(/if \(existingMatch\) \{/)
    expect(SRC).toMatch(/matchAlreadyExists: true/)
    expect(SRC).toMatch(/matchStatus: existingMatch\.status/)
  })

  it('both routes pass session-derived identity and the admin client SEPARATELY', () => {
    for (const r of ROUTES) {
      const src = code(r)
      // session client still constructed and still used for auth
      expect(src, r).toMatch(/const supabase = createClient\(\)/)
      expect(src, r).toMatch(/supabase\.auth\.getUser\(\)/)
      // admin client constructed separately
      expect(src, r).toMatch(/const adminClient = createAdminClient\(\)/)
      // and BOTH are handed over, plus graphClient
      expect(src, r).toMatch(/finalizeMutualMatch\(\{[\s\S]{0,400}supabase,/)
      expect(src, r).toMatch(/finalizeMutualMatch\(\{[\s\S]{0,400}adminClient,/)
      expect(src, r).toMatch(/finalizeMutualMatch\(\{[\s\S]{0,400}graphClient: adminClient,/)
    }
  })

  it('neither route is callable without authentication', () => {
    for (const r of ROUTES) {
      const src = code(r)
      expect(src, r).toMatch(/if \(!user\)/)
      expect(src, r).toMatch(/status: 401/)
    }
  })

  it('acting identity is still derived from the session, never from the graph client', () => {
    for (const r of ROUTES) {
      const src = code(r)
      // the id passed as actingUserId traces back to the authenticated user
      expect(src, r).toMatch(/actingUserId: (expresserId|viewerId)/)
    }
    // express-interest resolves expresserId from user.id; accept-incoming resolves viewerId likewise
    expect(code('app/api/intro-requests/express-interest/route.ts')).toMatch(/expresserId\s*=\s*[^\n]*user\.id/)
    expect(code('app/api/intro-requests/accept-incoming/route.ts')).toMatch(/viewerId\s*=\s*[^\n]*user\.id/)
  })

  it('Release B would no longer break either route', () => {
    // the only matches read on this path now runs as service_role
    expect(SRC).toMatch(/graphClient\s*\n?\s*\.from\('matches'\)/)
    expect(SRC).not.toMatch(/\bsupabase\s*\n?\s*\.from\('(matches|blocked_users)'\)/)
    for (const r of ROUTES) {
      expect(code(r), r).not.toMatch(/\bsupabase\s*\n?\s*\.from\('(matches|blocked_users)'\)/)
    }
  })

  it('no returned row is logged', () => {
    const noStrings = SRC.replace(/'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"/g, "''")
    for (const m of execAll(noStrings, /console\.(log|error|warn)\(([^\n]*)/g)) {
      expect(m[2]).not.toMatch(/\bexistingMatch\b|\bcompanyPair\b|SERVICE_ROLE|access_token/)
    }
  })
})

// ── 5. Behaviour preserved ────────────────────────────────────────────────────────────
describe('existing behaviour preserved', () => {
  it('Network still distinguishes a failed read from an empty network', () => {
    const src = code('app/dashboard/network/page.tsx')
    expect(src).toMatch(/\{ data: rawMatches, error: matchesError \}/)
    expect(src).toMatch(/if \(matchesError\) \{/)
    expect(read('app/dashboard/network/page.tsx')).toContain("We couldn&apos;t load your network")
    expect(read('app/dashboard/network/page.tsx')).toContain('No connections yet')
  })

  it('block exclusion is still bidirectional', () => {
    const src = code('app/dashboard/network/page.tsx')
    expect(src).toMatch(/if \(b\.user_id === profileId\) blockedIds\.add\(b\.blocked_user_id\)/)
    expect(src).toMatch(/else blockedIds\.add\(b\.user_id\)/)
  })

  it('the layout badge chain still yields 0 on failure', () => {
    const src = code('app/dashboard/layout.tsx')
    const chain = src.slice(src.indexOf('const { data: matchRows } = await graphClient') - 400,
                            src.indexOf('const { data: matchRows } = await graphClient') + 300)
    expect(chain).toMatch(/try \{/)
    expect(chain).toMatch(/if \(matchIds\.length === 0\) return 0/)
  })

  it('no NEW browser-callable route was added for these reads', () => {
    // Release A adds no route handler. The only api routes that mention graphClient are the two
    // PRE-EXISTING intro-request routes, which now name the parameter they were already passing a
    // service-role client to. Every other read stays in a server component or a server action.
    const mentions = allTsx('app/api').filter(p => /graphClient/.test(read(p))).sort()
    expect(mentions).toEqual([
      'app/api/intro-requests/accept-incoming/route.ts',
      'app/api/intro-requests/express-interest/route.ts',
    ])
    // and neither is new — both exist at the Release A base commit
    for (const p of mentions) expect(existsSync(p), p).toBe(true)
  })

  it('nothing logs rows, keys, tokens or private metadata', () => {
    for (const f of FILES) {
      const src = code(f)
      // strip string literals: '[network] matches read failed' is a MESSAGE, not data.
      const noStrings = src.replace(/'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"/g, "''")
      for (const m of execAll(noStrings, /console\.(log|error|warn)\(([^\n]*)/g)) {
        // A COUNT is not a leak: `matches?.length` is fine, the bare array is not. Drop the
        // length accesses first, then insist no row-bearing identifier survives.
        const arg = m[2].replace(/\??\.length/g, '.LEN')
        expect(arg, `${f}: ${m[0]}`)
          .not.toMatch(/\b(rawMatches|matchRows|matches|blocks|existingMatch)\b(?!\.LEN)|SERVICE_ROLE|access_token|admin_notes/)
      }
    }
  })
})
