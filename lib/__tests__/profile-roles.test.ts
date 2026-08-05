import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  normalizeRole,
  roleQualityFlags,
  listRoles,
  listRolesForProfiles,
  createRole,
  updateRole,
  deleteRole,
  reorderRoles,
  ROLE_CATEGORIES,
  MAX_ORG_LEN,
} from '@/lib/profileRoles'
import { isSameCompany } from '@/lib/matching/same-company'
import { matchProfileCompletion } from '@/lib/matching/profile-completion'

// ── Flexible fake Supabase client (records ops, returns handler results) ──────
function fakeDb(handler: (op: any) => any) {
  const calls: any[] = []
  function from(table: string) {
    const op: any = { table, kind: 'select', opts: null, eqs: [], in: null, payload: null }
    const exec = () => { calls.push(op); return handler(op) }
    const b: any = {
      select(_c: any, o: any) { op.opts = o; return b },
      insert(p: any) { op.kind = 'insert'; op.payload = p; return b },
      update(p: any) { op.kind = 'update'; op.payload = p; return b },
      delete() { op.kind = 'delete'; return b },
      eq(c: string, v: any) { op.eqs.push([c, v]); return b },
      in(c: string, v: any) { op.in = [c, v]; return b },
      order() { return b },
      single() { return Promise.resolve(exec()) },
      then(res: any, rej: any) { return Promise.resolve(exec()).then(res, rej) },
    }
    return b
  }
  return { db: { from }, calls }
}
const MISSING_TABLE = { code: '42P01', message: 'relation "public.profile_roles" does not exist' }

// ── normalizeRole ────────────────────────────────────────────────────────────
describe('normalizeRole', () => {
  it('rejects a blank organization', () => {
    expect(normalizeRole({ organization_name: '   ', role_category: 'board_member' })).toEqual({ ok: false, error: 'Organization is required.' })
  })

  it('rejects an invalid category', () => {
    const r = normalizeRole({ organization_name: 'Acme', role_category: 'ceo' })
    expect(r.ok).toBe(false)
  })

  it('accepts every allowed category', () => {
    for (const c of ROLE_CATEGORIES) {
      expect(normalizeRole({ organization_name: 'Acme', role_category: c }).ok).toBe(true)
    }
  })

  it('trims + collapses whitespace and defaults optionals to null', () => {
    const r = normalizeRole({ organization_name: '  Acme   Foundation ', role_category: 'nonprofit' })
    expect(r).toEqual({ ok: true, value: { organization_name: 'Acme Foundation', title: null, role_category: 'nonprofit', industry: null, is_current: true, description: null } })
  })

  it('caps organization length', () => {
    const r = normalizeRole({ organization_name: 'x'.repeat(MAX_ORG_LEN + 50), role_category: 'other' })
    expect(r.ok && r.value.organization_name.length).toBe(MAX_ORG_LEN)
  })

  it('parses current/past state', () => {
    expect((normalizeRole({ organization_name: 'A', role_category: 'other', is_current: 'past' }) as any).value.is_current).toBe(false)
    expect((normalizeRole({ organization_name: 'A', role_category: 'other', is_current: false }) as any).value.is_current).toBe(false)
    expect((normalizeRole({ organization_name: 'A', role_category: 'other' }) as any).value.is_current).toBe(true)
  })
})

// ── CRUD: ownership + isolation ──────────────────────────────────────────────
describe('CRUD scoping — ownership + isolation from profiles', () => {
  it('createRole inserts into profile_roles with is_primary=false; never writes profiles', async () => {
    const { db, calls } = fakeDb((op) =>
      op.opts?.head ? { count: 1 } : { data: { id: 'r1' }, error: null })
    const res = await createRole(db, 'u1', { organization_name: 'Acme', role_category: 'board_member' })
    expect(res.ok).toBe(true)
    const insert = calls.find((c) => c.kind === 'insert')
    expect(insert.table).toBe('profile_roles')
    expect(insert.payload.profile_id).toBe('u1')
    expect(insert.payload.is_primary).toBe(false)
    expect(calls.every((c) => c.table === 'profile_roles')).toBe(true) // never touches profiles
  })

  it('updateRole is scoped by BOTH id and profile_id (ownership)', async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ id: 'r1' }], error: null }))
    await updateRole(db, 'u1', 'r1', { organization_name: 'Acme', role_category: 'advisor' })
    const upd = calls.find((c) => c.kind === 'update')
    expect(upd.eqs).toContainEqual(['id', 'r1'])
    expect(upd.eqs).toContainEqual(['profile_id', 'u1'])
  })

  it('updateRole returns 404 when the row is not owned (0 rows)', async () => {
    const { db } = fakeDb(() => ({ data: [], error: null }))
    const res = await updateRole(db, 'u1', 'rX', { organization_name: 'Acme', role_category: 'advisor' })
    expect(res.status).toBe(404)
  })

  it('deleteRole is scoped by id + profile_id', async () => {
    const { db, calls } = fakeDb(() => ({ error: null }))
    await deleteRole(db, 'u1', 'r1')
    const del = calls.find((c) => c.kind === 'delete')
    expect(del.eqs).toContainEqual(['id', 'r1'])
    expect(del.eqs).toContainEqual(['profile_id', 'u1'])
  })

  it('reorderRoles applies sort_order only to owned ids', async () => {
    const owned = [{ id: 'a' }, { id: 'b' }]
    const { db, calls } = fakeDb((op) => (op.kind === 'update' ? { error: null } : { data: owned, error: null }))
    const res = await reorderRoles(db, 'u1', ['b', 'a', 'not-owned'])
    expect(res.ok).toBe(true)
    const updates = calls.filter((c) => c.kind === 'update')
    expect(updates).toHaveLength(2) // 'not-owned' filtered out
    for (const u of updates) expect(u.eqs).toContainEqual(['profile_id', 'u1'])
  })
})

// ── Fail-open when migration 042 is not applied ──────────────────────────────
describe('fail-open (table missing)', () => {
  it('listRoles → []', async () => {
    const { db } = fakeDb(() => ({ data: null, error: MISSING_TABLE }))
    expect(await listRoles(db, 'u1')).toEqual([])
  })
  it('listRolesForProfiles → {}', async () => {
    const { db } = fakeDb(() => ({ data: null, error: MISSING_TABLE }))
    expect(await listRolesForProfiles(db, ['u1', 'u2'])).toEqual({})
  })
  it('createRole → 503 persisted:false', async () => {
    const { db } = fakeDb((op) => (op.opts?.head ? { count: 0 } : { data: null, error: MISSING_TABLE }))
    const res = await createRole(db, 'u1', { organization_name: 'Acme', role_category: 'other' })
    expect(res.status).toBe(503)
    expect(res.persisted).toBe(false)
  })
  it('updateRole / deleteRole → 503 persisted:false', async () => {
    const { db } = fakeDb(() => ({ data: null, error: MISSING_TABLE }))
    expect((await updateRole(db, 'u1', 'r', { organization_name: 'A', role_category: 'other' })).status).toBe(503)
    expect((await deleteRole(db, 'u1', 'r')).status).toBe(503)
  })
})

// ── listRolesForProfiles grouping (single query, no N+1) ─────────────────────
describe('listRolesForProfiles', () => {
  it('groups rows by profile_id in ONE query', async () => {
    const rows = [
      { id: '1', profile_id: 'u1', role_category: 'board_member' },
      { id: '2', profile_id: 'u1', role_category: 'advisor' },
      { id: '3', profile_id: 'u2', role_category: 'nonprofit' },
    ]
    const { db, calls } = fakeDb(() => ({ data: rows, error: null }))
    const grouped = await listRolesForProfiles(db, ['u1', 'u2'])
    expect(grouped.u1).toHaveLength(2)
    expect(grouped.u2).toHaveLength(1)
    expect(calls.filter((c) => c.table === 'profile_roles')).toHaveLength(1) // no N+1
  })
  it('empty id list short-circuits without a query', async () => {
    const { db, calls } = fakeDb(() => ({ data: [], error: null }))
    expect(await listRolesForProfiles(db, [])).toEqual({})
    expect(calls).toHaveLength(0)
  })
})

// ── roleQualityFlags ─────────────────────────────────────────────────────────
describe('roleQualityFlags', () => {
  it('flags blank org, invalid category, duplicate orgs, multiple primary', () => {
    const q = roleQualityFlags([
      { organization_name: '', role_category: 'other', is_primary: true } as any,
      { organization_name: 'Acme', role_category: 'board_member', is_primary: true } as any,
      { organization_name: 'acme', role_category: 'zzz' as any, is_primary: false } as any,
    ])
    expect(q.hasBlankOrg).toBe(true)
    expect(q.hasInvalidCategory).toBe(true)
    expect(q.duplicateOrganizations).toContain('acme')
    expect(q.multiplePrimary).toBe(true)
  })
  it('clean roles → no flags', () => {
    const q = roleQualityFlags([{ organization_name: 'Acme', role_category: 'board_member', is_primary: false } as any])
    expect(q).toEqual({ hasBlankOrg: false, hasInvalidCategory: false, duplicateOrganizations: [], multiplePrimary: false })
  })
})

// ── Isolation: matching + completion untouched ───────────────────────────────
describe('isolation from matching + completion', () => {
  it('a shared additional affiliation does NOT trigger same-company exclusion', () => {
    // Members at different primary companies who happen to share a board are NOT
    // same-company. isSameCompany reads ONLY profiles.company.
    expect(isSameCompany({ company: 'Acme' }, { company: 'Globex' })).toBe(false)
  })
  it('profile completion never counts additional roles', () => {
    const complete = { intro_preferences: ['Founders'], purposes: ['Hiring'], expertise: ['AI'] }
    expect(matchProfileCompletion({ ...complete, additional_roles: [{ organization_name: 'Acme' }] } as any).complete).toBe(true)
    expect(matchProfileCompletion({ additional_roles: [{ organization_name: 'Acme' }] } as any).complete).toBe(false)
  })
})

// ── Structural wiring ────────────────────────────────────────────────────────
describe('Phase A/B wiring', () => {
  const migration = readFileSync('supabase/migrations/042_profile_roles.sql', 'utf8')
  const health = readFileSync('lib/db/migrationHealth.ts', 'utf8')
  const dataLayer = readFileSync('lib/profileRoles/index.ts', 'utf8')
  const sameCompany = readFileSync('lib/matching/same-company.ts', 'utf8')
  const completion = readFileSync('lib/matching/profile-completion.ts', 'utf8')
  const profileForm = readFileSync('components/ProfileForm.tsx', 'utf8')
  const profilePage = readFileSync('app/dashboard/profile/[id]/page.tsx', 'utf8')
  const adminPage = readFileSync('app/dashboard/admin/members/page.tsx', 'utf8')
  const adminClient = readFileSync('components/AdminMembersClient.tsx', 'utf8')

  it('migration is additive/idempotent with the required indexes + check constraint', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.profile_roles')
    expect(migration).toContain('profile_roles_profile_id_idx')
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS profile_roles_one_primary_idx[\s\S]*WHERE is_primary/)
    expect(migration).toContain('profile_roles_role_category_chk')
    expect(migration).not.toMatch(/DROP|TRUNCATE|DELETE FROM/i)
  })

  it('migration-health registers 042 as a table', () => {
    expect(health).toContain("042_profile_roles.sql")
    expect(health).toContain("table: 'profile_roles'")
  })

  it('the data layer only ever queries the profile_roles table', () => {
    const tables = Array.from(dataLayer.matchAll(/\.from\('([^']+)'\)/g)).map((m) => m[1])
    expect(new Set(tables)).toEqual(new Set(['profile_roles']))
  })

  it('same-company + completion are unchanged (do not reference profile_roles)', () => {
    expect(sameCompany).not.toContain('profile_roles')
    expect(sameCompany).toContain('a.company') // still compares only company
    expect(completion).not.toContain('profile_roles')
    expect(completion).toContain("'intro_preferences' | 'purposes' | 'expertise'")
  })

  it('profile editor + display + admin are wired fail-open', () => {
    expect(profileForm).toContain('<AdditionalRolesEditor')
    expect(profilePage).toContain('listRoles(createAdminClient()')
    expect(profilePage).toContain('additionalRoles.length > 0')
    expect(adminPage).toContain('listRolesForProfiles')
    expect(adminClient).toContain('roleQualityFlags')
  })

  it('admin roles fetch uses the SERVICE-ROLE client (not the user-scoped one) — RLS visibility fix', () => {
    // Owner-only RLS on profile_roles hides other members' rows from the
    // user-scoped client; the admin bulk fetch must use the service-role client.
    expect(adminPage).toContain('listRolesForProfiles(createAdminClient()')
    expect(adminPage).not.toContain('listRolesForProfiles(supabase')
    expect(adminPage).toContain("import { createAdminClient }")
  })

  it('the admin page still gates non-admins exactly as before (redirect), before the roles fetch', () => {
    expect(adminPage).toContain("user.email !== ADMIN_EMAIL) redirect('/dashboard')")
    // gate must run BEFORE the roles fetch (compare the gate to the CALL site,
    // not the import of listRolesForProfiles at the top of the file)
    expect(adminPage.indexOf("redirect('/dashboard')"))
      .toBeLessThan(adminPage.indexOf('listRolesForProfiles(createAdminClient'))
    // member/profile queries are unchanged: still the user-scoped client
    expect(adminPage).toContain("const supabase = createClient()")
    expect(adminPage).toMatch(/supabase\s*\n?\s*\.from\('profiles'\)/)
  })
})
