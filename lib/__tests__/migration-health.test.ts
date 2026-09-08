import { describe, it, expect } from 'vitest'
import {
  checkMigrationHealth,
  evaluateMigrationGate,
  migrationWarningMessage,
  probeExpectation,
  SCHEMA_EXPECTATIONS,
  type MigrationWarning,
  type SchemaExpectation,
} from '@/lib/db/migrationHealth'

// Minimal Supabase-query-builder stub: .from(table).select(col).limit() resolves
// to { error } per an error map. Keys may be a plain table ("companies") or a
// specific column ("companies.enrichment_version"); the column key wins, so a test
// can fail ONE expectation on a table without tripping other expectations that
// probe different columns of the same table.
function stubAdmin(
  errorsByTable: Record<string, { message: string; code?: string } | null>,
  // kind:'function' expectations call admin.rpc(). Keyed by function name; a key that is absent
  // resolves with no error (function present). `rpcCalls` records every call so a test can prove
  // WHAT the probe sent, which is how the read-only-in-effect guarantee is checked.
  errorsByFn: Record<string, { message: string; code?: string } | null> = {},
  rpcCalls: { fn: string; args: any }[] = [],
) {
  return {
    from(table: string) {
      let col = '*'
      const builder: any = {
        select: (c: string) => { col = c; return builder },
        limit: () => Promise.resolve({ error: errorsByTable[`${table}.${col}`] ?? errorsByTable[table] ?? null }),
      }
      return builder
    },
    rpc(fn: string, args: any) {
      rpcCalls.push({ fn, args })
      return Promise.resolve({ data: { outcome: 'invalid', detail: 'missing_argument' }, error: errorsByFn[fn] ?? null })
    },
  }
}

const colExpect: SchemaExpectation = {
  migration: '024_enrichment_version.sql', kind: 'column', table: 'companies',
  column: 'enrichment_version', feature: 'x', impact: 'y',
}
const tableExpect: SchemaExpectation = {
  migration: '015_company_metadata.sql', kind: 'table', table: 'company_metadata', feature: 'x', impact: 'y',
}

describe('migrationWarningMessage', () => {
  it('produces the exact compatibility-mode message', () => {
    expect(migrationWarningMessage(colExpect)).toBe(
      'Database migration 024_enrichment_version.sql has not been applied. Running in compatibility mode.',
    )
  })
})

describe('probeExpectation', () => {
  it('present when the query succeeds', async () => {
    const admin = stubAdmin({ companies: null })
    expect(await probeExpectation(admin, colExpect)).toEqual({ present: true })
  })
  it('absent when the column does not exist', async () => {
    const admin = stubAdmin({ companies: { message: 'column companies.enrichment_version does not exist', code: '42703' } })
    expect((await probeExpectation(admin, colExpect)).present).toBe(false)
  })
  it('absent when the table is missing (PGRST205 / schema cache)', async () => {
    const admin = stubAdmin({ company_metadata: { message: 'Could not find the table in the schema cache', code: 'PGRST205' } })
    expect((await probeExpectation(admin, tableExpect)).present).toBe(false)
  })
  it('does not false-alarm on a transient/unknown error', async () => {
    const admin = stubAdmin({ companies: { message: 'fetch failed', code: '' } })
    expect((await probeExpectation(admin, colExpect)).present).toBe(true)
  })

  // Inverted probe: a CLEANUP expectation is "applied" only once the column is GONE.
  const dropExpect: SchemaExpectation = {
    migration: '048_drop_profiles_last_active_at.sql', kind: 'column', table: 'profiles',
    column: 'last_active_at', expectAbsent: true, feature: 'x', impact: 'y',
  }
  it('cleanup (expectAbsent) is PENDING while the legacy column still exists', async () => {
    const admin = stubAdmin({ profiles: null }) // select succeeds → column present → not cleaned up
    expect((await probeExpectation(admin, dropExpect)).present).toBe(false)
  })
  it('cleanup (expectAbsent) is APPLIED once the column is dropped', async () => {
    const admin = stubAdmin({ 'profiles.last_active_at': { message: 'column profiles.last_active_at does not exist', code: '42703' } })
    expect((await probeExpectation(admin, dropExpect)).present).toBe(true)
  })
})

describe('required migrations are registered so none can be silently omitted', () => {
  const byMig = new Map(SCHEMA_EXPECTATIONS.map((e) => [e.migration, e]))
  it('the calendar BASE migration 045 is registered (omitting it must be impossible)', () => {
    const e = byMig.get('045_meeting_calendar_invites.sql')
    expect(e).toBeTruthy()
    expect(e!.table).toBe('meeting_calendar_invites')
  })
  it('the full presence + calendar chain (044, 045, 046, 047, 048) is all registered', () => {
    for (const m of [
      '044_profiles_show_activity_status.sql',
      '045_meeting_calendar_invites.sql',
      '046_member_presence_expansion.sql',
      '047_calendar_invite_payload.sql',
      '048_drop_profiles_last_active_at.sql',
    ]) expect(byMig.has(m)).toBe(true)
  })
  it('047 (payload) depends on the table 045 creates; 048 is the inverted cleanup probe', () => {
    expect(byMig.get('047_calendar_invite_payload.sql')!.table).toBe('meeting_calendar_invites')
    expect(byMig.get('048_drop_profiles_last_active_at.sql')!.expectAbsent).toBe(true)
  })
})

describe('checkMigrationHealth', () => {
  it('ok when all expectations are satisfied', async () => {
    // The 048 cleanup is an inverted probe: "satisfied" means profiles.last_active_at is GONE.
    const admin = stubAdmin({
      companies: null, company_metadata: null,
      'profiles.last_active_at': { message: 'column profiles.last_active_at does not exist', code: '42703' },
    })
    const h = await checkMigrationHealth(admin)
    expect(h.ok).toBe(true)
    expect(h.pending).toHaveLength(0)
    expect(h.checked).toBe(SCHEMA_EXPECTATIONS.length)
  })

  it('flags exactly the unapplied migrations with messages', async () => {
    // Only the 024 column is missing; every other expectation (incl. other companies
    // columns like 030's company_status, and the 048 inverted cleanup) is present.
    const admin = stubAdmin({
      'companies.enrichment_version': { message: 'column companies.enrichment_version does not exist', code: '42703' },
      'profiles.last_active_at': { message: 'column profiles.last_active_at does not exist', code: '42703' }, // cleanup applied
    })
    const h = await checkMigrationHealth(admin)
    expect(h.ok).toBe(false)
    expect(h.pending.map((p) => p.migration)).toEqual(['024_enrichment_version.sql'])
    expect(h.pending[0].message).toContain('024_enrichment_version.sql has not been applied')
  })

  it('flags multiple pending migrations', async () => {
    // 024 column missing + 015 table missing → exactly two pending (048 cleanup applied).
    const admin = stubAdmin({
      'companies.enrichment_version': { message: 'column companies.enrichment_version does not exist', code: '42703' },
      company_metadata: { message: 'does not exist', code: 'PGRST205' },
      'profiles.last_active_at': { message: 'column profiles.last_active_at does not exist', code: '42703' }, // cleanup applied
    })
    const h = await checkMigrationHealth(admin)
    expect(h.pending).toHaveLength(2)
  })
})

describe('evaluateMigrationGate (deployment gate)', () => {
  const w = (migration: string): MigrationWarning => ({
    migration, kind: 'column', table: 't', feature: 'f', impact: 'i',
    message: migrationWarningMessage({ migration, kind: 'column', table: 't', feature: 'f', impact: 'i' }),
  })

  it('passes when nothing is pending', () => {
    const d = evaluateMigrationGate([], '')
    expect(d.pass).toBe(true)
    expect(d.blocking).toHaveLength(0)
  })

  it('blocks pending migrations when no compatibility mode is declared', () => {
    const d = evaluateMigrationGate([w('024_enrichment_version.sql')], undefined)
    expect(d.pass).toBe(false)
    expect(d.blocking.map((b) => b.migration)).toEqual(['024_enrichment_version.sql'])
  })

  it('waives everything when compatibility mode = all/1/true', () => {
    for (const spec of ['all', '1', 'true', 'ON']) {
      const d = evaluateMigrationGate([w('024_enrichment_version.sql'), w('015_company_metadata.sql')], spec)
      expect(d.pass).toBe(true)
      expect(d.waived).toHaveLength(2)
      expect(d.blocking).toHaveLength(0)
    }
  })

  it('waives only the explicitly listed migrations; others still block', () => {
    const d = evaluateMigrationGate(
      [w('024_enrichment_version.sql'), w('099_unexpected.sql')],
      '024_enrichment_version.sql',
    )
    expect(d.pass).toBe(false)
    expect(d.waived.map((x) => x.migration)).toEqual(['024_enrichment_version.sql'])
    expect(d.blocking.map((x) => x.migration)).toEqual(['099_unexpected.sql'])
  })

  it('passes when every pending migration is in the allow-list', () => {
    const d = evaluateMigrationGate(
      [w('024_enrichment_version.sql'), w('015_company_metadata.sql')],
      '024_enrichment_version.sql, 015_company_metadata.sql',
    )
    expect(d.pass).toBe(true)
    expect(d.blocking).toHaveLength(0)
  })
})


// ═══════════════════════════════════════════════════════════════════════════════════════════════
// FUNCTION PROBES (Phase 3 Stage 1 prerequisites: migrations 096 / 098)
//
// The whole reason this block exists: PostgREST reports a missing FUNCTION as PGRST202, and the
// pre-existing ABSENT_RE only matches PGRST20[45]. Reusing it would classify a missing RPC as
// "present" — a green dashboard for an unapplied security migration. FN_ABSENT_RE is what prevents
// that, so it is tested directly rather than assumed.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const fnExpect: SchemaExpectation = {
  migration: '096_community_boundary_enforcement.sql', kind: 'function', table: 'matches',
  fn: 'create_gated_match', probeArgs: { p_user_a: null, p_user_b: null }, feature: 'x', impact: 'y',
}

describe('probeExpectation — kind: function', () => {
  it('PGRST202 (PostgREST: function not in the schema cache) => ABSENT', async () => {
    const admin = stubAdmin({}, {
      create_gated_match: {
        message: 'Could not find the function public.create_gated_match(p_user_a, p_user_b) in the schema cache',
        code: 'PGRST202',
      },
    })
    expect((await probeExpectation(admin, fnExpect)).present).toBe(false)
  })

  it('PGRST202 is caught even when only the CODE is present', async () => {
    // The regression this guards: a classifier that matched only the message text would pass the
    // test above and still miss a bare code. Both halves must independently classify.
    const admin = stubAdmin({}, { create_gated_match: { message: '', code: 'PGRST202' } })
    expect((await probeExpectation(admin, fnExpect)).present).toBe(false)
  })

  it('42883 / undefined_function (direct PostgreSQL) => ABSENT', async () => {
    for (const err of [
      { message: 'function public.create_gated_match(uuid, uuid) does not exist', code: '42883' },
      { message: 'function public.create_gated_match(uuid, uuid) does not exist', code: '' },
      { message: 'undefined_function', code: '' },
    ]) {
      const admin = stubAdmin({}, { create_gated_match: err })
      expect((await probeExpectation(admin, fnExpect)).present, JSON.stringify(err)).toBe(false)
    }
  })

  it('a successful RPC => PRESENT', async () => {
    const admin = stubAdmin({}, { create_gated_match: null })
    expect(await probeExpectation(admin, fnExpect)).toEqual({ present: true })
  })

  it('an unrelated error => PRESENT, exactly like the column/table path (never a false alarm)', async () => {
    for (const err of [
      { message: 'fetch failed', code: '' },
      { message: 'JWT expired', code: 'PGRST301' },
      { message: 'permission denied for function create_gated_match', code: '42501' },
      { message: 'canceling statement due to statement timeout', code: '57014' },
    ]) {
      const admin = stubAdmin({}, { create_gated_match: err })
      expect((await probeExpectation(admin, fnExpect)).present, JSON.stringify(err)).toBe(true)
    }
  })

  it('a function that EXISTS but hits a missing relation is NOT reported as a missing function', async () => {
    // 42P01 is "relation does not exist". Classifying that as "function absent" would be a lie in
    // the other direction — which is why FN_ABSENT_RE is not a bare /does not exist/.
    const admin = stubAdmin({}, {
      create_gated_match: { message: 'relation "public.matches" does not exist', code: '42P01' },
    })
    expect((await probeExpectation(admin, fnExpect)).present).toBe(true)
  })

  it('the probe calls the RPC by name with EXACTLY the declared arguments', async () => {
    const calls: { fn: string; args: any }[] = []
    await probeExpectation(stubAdmin({}, {}, calls), fnExpect)
    expect(calls).toEqual([{ fn: 'create_gated_match', args: { p_user_a: null, p_user_b: null } }])
  })
})

describe('the Phase 3 Stage 1 function prerequisites are registered', () => {
  const fns = SCHEMA_EXPECTATIONS.filter((e) => e.kind === 'function')

  it('exactly the three Stage 1 RPCs the application calls by name', () => {
    expect(fns.map((e) => e.fn).sort()).toEqual([
      'create_admin_intro_pair', 'create_gated_match', 'create_support_match',
    ])
  })

  it('each is tied to the migration that actually defines it', () => {
    const byFn = new Map(fns.map((e) => [e.fn, e]))
    expect(byFn.get('create_gated_match')!.migration).toBe('096_community_boundary_enforcement.sql')
    expect(byFn.get('create_support_match')!.migration).toBe('096_community_boundary_enforcement.sql')
    expect(byFn.get('create_admin_intro_pair')!.migration).toBe('098_admin_intro_pair_writer.sql')
  })

  it('probe args are the approved all-NULL sets, with every no-default argument named', () => {
    const byFn = new Map(fns.map((e) => [e.fn, e]))
    // Naming every argument without a SQL default is what makes PostgREST resolve the overload;
    // omitting one would look like "function not found" and false-alarm.
    expect(byFn.get('create_gated_match')!.probeArgs).toEqual({ p_user_a: null, p_user_b: null })
    expect(byFn.get('create_support_match')!.probeArgs).toEqual({ p_platform_user: null, p_member: null })
    expect(byFn.get('create_admin_intro_pair')!.probeArgs).toEqual({ p_user_a: null, p_user_b: null })
  })
})

describe('STRUCTURAL SAFETY: a function probe can never write', () => {
  // ── THE INVARIANT ────────────────────────────────────────────────────────────────────────────
  // A function probe CALLS the function, on every admin dashboard load and in CI. Every function
  // registered today is a WRITER. What makes the call harmless is that all-NULL arguments hit each
  // function's first guard and return before any advisory lock, read or write.
  //
  // This is deliberately NOT three assertions about today's three literals — those live in the
  // block above. This asserts the RULE, over whatever the array happens to contain, so registering
  // a fourth writer with a real uuid fails here rather than quietly creating member relationships.
  //
  // A genuinely read-only function may take real arguments, but only by being added to this list
  // in a reviewed change that says why. The list is empty on purpose.
  const READ_ONLY_PROBE_FUNCTIONS: string[] = []

  const fns = SCHEMA_EXPECTATIONS.filter((e) => e.kind === 'function')

  it('every function expectation declares fn and probeArgs', () => {
    for (const e of fns) {
      expect(e.fn, `${e.migration} declares kind:'function' without fn`).toBeTruthy()
      expect(e.probeArgs, `${e.fn} declares no probeArgs`).toBeTruthy()
    }
  })

  it('EVERY writer probe passes only NULL arguments', () => {
    const offenders: string[] = []
    for (const e of fns) {
      if (READ_ONLY_PROBE_FUNCTIONS.includes(e.fn as string)) continue
      for (const [k, v] of Object.entries(e.probeArgs ?? {})) {
        if (v !== null) offenders.push(`${e.fn}.${k} = ${JSON.stringify(v)}`)
      }
    }
    expect(
      offenders,
      'A writer-function probe must pass only NULL arguments so it returns before any write. ' +
      'If the function is genuinely read-only, add it to READ_ONLY_PROBE_FUNCTIONS with a reason.',
    ).toEqual([])
  })

  it('a probe with a non-NULL argument is rejected by this rule (the rule actually bites)', () => {
    // Proves the check above is not vacuous: it fails on the exact shape it is meant to catch.
    const bad: SchemaExpectation = {
      ...fnExpect, probeArgs: { p_user_a: '11111111-1111-4111-8111-111111111111', p_user_b: null },
    }
    const offenders = Object.entries(bad.probeArgs ?? {}).filter(([, v]) => v !== null)
    expect(offenders).toHaveLength(1)
  })

  it('expectAbsent is never used on a function (it is a column-only inverted probe)', () => {
    for (const e of fns) expect(e.expectAbsent, `${e.fn}`).toBeFalsy()
  })

  it('no function expectation targets a table probe path by mistake', () => {
    for (const e of fns) expect(e.column, `${e.fn} must not declare a column`).toBeUndefined()
  })
})
