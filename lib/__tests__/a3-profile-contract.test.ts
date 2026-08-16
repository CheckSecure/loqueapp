import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  PUBLIC_PROFILE_COLUMNS, PUBLIC_PROFILE_SELECT, FORBIDDEN_PUBLIC_PROFILE_FIELDS,
  fetchPublicProfilesByIds, getMyProfile,
} from '@/lib/profiles/publicProfile'

const M057 = readFileSync('supabase/migrations/057_public_profiles_contract_expand.sql', 'utf8')
const M058 = readFileSync('supabase/migrations/058_revoke_authenticated_profiles_select.sql', 'utf8')
const sqlOnly = (s: string) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
const M057SQL = sqlOnly(M057)
const M058SQL = sqlOnly(M058)
// The public_profiles view's column projection (between its SELECT and FROM).
const VIEW_PROJ = (M057SQL.match(/CREATE VIEW public\.public_profiles[\s\S]*?SELECT([\s\S]*?)FROM public\.profiles/) || [])[1] || ''
// The get_my_profile RETURNS TABLE(...) declaration.
const RPC_DECL = (M057SQL.match(/get_my_profile\(\)\s*RETURNS TABLE\s*\(([\s\S]*?)\)\s*LANGUAGE/) || [])[1] || ''

describe('A3 public_profiles column allowlist — account_status + private fields excluded', () => {
  it('account_status is NOT in the public allowlist and IS in the forbidden list', () => {
    expect(PUBLIC_PROFILE_COLUMNS as readonly string[]).not.toContain('account_status')
    expect(FORBIDDEN_PUBLIC_PROFILE_FIELDS as readonly string[]).toContain('account_status')
  })
  it('no forbidden field appears in the allowlist; needed display fields present', () => {
    for (const f of FORBIDDEN_PUBLIC_PROFILE_FIELDS) expect(PUBLIC_PROFILE_COLUMNS as readonly string[]).not.toContain(f)
    for (const f of ['id', 'full_name', 'avatar_url', 'title', 'company', 'role_type', 'seniority']) {
      expect(PUBLIC_PROFILE_COLUMNS as readonly string[]).toContain(f)
    }
  })
  it('select string mirrors the allowlist and is never SELECT *', () => {
    expect(PUBLIC_PROFILE_SELECT).toBe(PUBLIC_PROFILE_COLUMNS.join(', '))
    expect(PUBLIC_PROFILE_SELECT).not.toContain('*')
  })
})

describe('A3 migration 057 — DROP+recreate definer view (no account_status), SELECT-only grant', () => {
  it('DROPs then CREATEs the view (safe given zero DB deps) with security_invoker off + barrier on', () => {
    expect(M057SQL).toMatch(/DROP VIEW IF EXISTS public\.public_profiles/)
    // Whitespace-agnostic so it accepts both the migration form (`security_invoker = off`) and
    // PostgreSQL's stored reloptions form (`security_invoker=off`, `security_barrier=on`).
    expect(M057SQL).toMatch(/CREATE VIEW public\.public_profiles\s+WITH \(\s*security_invoker\s*=\s*off\s*,\s*security_barrier\s*=\s*on\s*\)/)
    expect(M057SQL).toMatch(/security_invoker\s*=\s*off/)
    expect(M057SQL).toMatch(/security_barrier\s*=\s*on/)
    expect(M057SQL).toMatch(/WHERE public\.can_discover_profile\(id\)/)
  })
  it('the view projection excludes account_status and every forbidden field; never SELECT *', () => {
    expect(VIEW_PROJ).not.toContain('*')
    for (const f of ['account_status', 'email', 'subscription_tier', 'stripe_customer_id', 'trust_score', 'verification_status', 'password_reset_required', 'is_admin', 'last_active_at', 'phone']) {
      expect(VIEW_PROJ).not.toMatch(new RegExp(`\\b${f}\\b`))
    }
  })
  it('view grants: REVOKE ALL from PUBLIC/anon/authenticated, then GRANT SELECT (only) to authenticated', () => {
    expect(M057SQL).toMatch(/REVOKE ALL ON TABLE public\.public_profiles FROM PUBLIC, anon, authenticated/)
    expect(M057SQL).toMatch(/GRANT SELECT ON TABLE public\.public_profiles TO authenticated/)
    // no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER granted on the view to a browser role
    expect(M057SQL).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)[^;]*public\.public_profiles[^;]*TO (anon|authenticated)/)
  })
})

describe('A3 migration 057 — get_my_profile explicit schema (no SETOF profiles, no SELECT *)', () => {
  it('uses RETURNS TABLE with an explicit column list — NOT RETURNS SETOF profiles', () => {
    expect(M057SQL).toMatch(/get_my_profile\(\)\s*RETURNS TABLE\s*\(/)
    expect(M057SQL).not.toMatch(/RETURNS SETOF public\.profiles/)
    expect(RPC_DECL.length).toBeGreaterThan(0)
    expect(RPC_DECL).toMatch(/\bid uuid\b/)
  })
  it('declares the PRODUCTION-VERIFIED column types (expertise is text; the other multiselects are text[])', () => {
    expect(RPC_DECL).toMatch(/\bexpertise text\b/)      // production: profiles.expertise is text
    expect(RPC_DECL).not.toMatch(/\bexpertise text\[\]/) // must NOT be an array
    expect(RPC_DECL).toMatch(/\binterests text\[\]/)
    expect(RPC_DECL).toMatch(/\bintro_preferences text\[\]/)
    expect(RPC_DECL).toMatch(/\bpurposes text\[\]/)
  })
  it('the RETURNS TABLE allowlist excludes internal/moderation/admin/operational fields', () => {
    for (const f of ['is_admin', 'is_priority', 'boost_score', 'trust_score', 'verification_status', 'verification_metadata', 'stripe_customer_id', 'last_active_at', 'account_status', 'is_test_account', 'referral_campaign_sent_at']) {
      expect(RPC_DECL).not.toMatch(new RegExp(`\\b${f}\\b`))
    }
  })
  it('SECURITY DEFINER, empty search_path, auth.uid()-bound, no argument, no SELECT *', () => {
    expect(M057SQL).toMatch(/CREATE OR REPLACE FUNCTION public\.get_my_profile\(\)/) // no params
    expect(M057SQL).toMatch(/SECURITY DEFINER/)
    expect(M057SQL).toMatch(/SET search_path = ''/)
    expect(M057SQL).toMatch(/WHERE p\.id = auth\.uid\(\)/)
    expect(M057SQL).not.toMatch(/SELECT \*\s+FROM public\.profiles p/)
    expect(M057SQL).toMatch(/REVOKE ALL ON FUNCTION public\.get_my_profile\(\) FROM PUBLIC, anon/)
    expect(M057SQL).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_my_profile\(\) TO authenticated/)
  })
})

describe('A3 migration 057 — intro_requests policy no longer references profiles', () => {
  it('drops the "or admins" policy and creates a participant-only policy (no profiles subquery)', () => {
    expect(M057SQL).toMatch(/DROP POLICY IF EXISTS "Users can read intro requests where they are involved or admins" ON public\.intro_requests/)
    expect(M057SQL).toMatch(/CREATE POLICY "Users can read intro requests where they are involved"[\s\S]*USING \(requester_id = auth\.uid\(\) OR target_user_id = auth\.uid\(\)\)/)
    // the new policy block must not query profiles
    const pol = (M057SQL.match(/CREATE POLICY "Users can read intro requests where they are involved"[\s\S]*?;/) || [''])[0]
    expect(pol).not.toMatch(/\bprofiles\b/)
    expect(pol).not.toMatch(/is_admin/)
  })
  it('can_discover_profile is hardened to an empty search_path', () => {
    expect(M057SQL).toMatch(/CREATE OR REPLACE FUNCTION public\.can_discover_profile[\s\S]*SET search_path = ''/)
  })
  it('057 does NOT revoke base-table SELECT and does no 048 work', () => {
    expect(M057SQL).not.toMatch(/REVOKE SELECT ON (TABLE )?public\.profiles/)
    expect(M057SQL).not.toMatch(/\b048\b|last_active_at/)
  })
})

describe('A3 migration 058 — revoke base SELECT, preserve service_role', () => {
  it('revokes SELECT on profiles from PUBLIC/anon/authenticated; preserves service_role; no 048', () => {
    expect(M058SQL).toMatch(/REVOKE SELECT ON TABLE public\.profiles FROM PUBLIC, anon, authenticated/)
    expect(M058SQL).toMatch(/GRANT SELECT[^;]*ON TABLE public\.profiles TO service_role/)
    expect(M058SQL).not.toMatch(/\b048\b|last_active_at/)
  })
})

describe('A3 self-facing surfaces no longer read base profiles via a browser/user client', () => {
  const browserSelf = ['app/dashboard/billing/page.tsx', 'app/dashboard/onboarding/page.tsx', 'app/dashboard/verify-email/page.tsx', 'middleware.ts']
  it('browser/edge self surfaces use get_my_profile and do not touch the base table', () => {
    for (const f of browserSelf) {
      const src = readFileSync(f, 'utf8')
      expect(src).not.toMatch(/\.from\(\s*['"]profiles['"]\s*\)/)
      expect(src).toMatch(/get_my_profile/)
    }
  })
})

describe('A3 helper behavior', () => {
  it('fetchPublicProfilesByIds dedups + maps by id, empty on no ids', async () => {
    const calls: any[] = []
    const client = { from: (_t: string) => ({ select: (_s: string) => ({ in: async (_c: string, ids: string[]) => { calls.push(ids); return { data: ids.map((id) => ({ id })) } } }) }) }
    const map = await fetchPublicProfilesByIds(client, ['a', 'a', 'b', null, undefined])
    expect(calls[0].sort()).toEqual(['a', 'b'])
    expect(map.size).toBe(2)
    expect((await fetchPublicProfilesByIds(client, [null, undefined])).size).toBe(0)
  })
  it('getMyProfile returns the single self row, null on error', async () => {
    expect(await getMyProfile({ rpc: async () => ({ data: [{ id: 'me' }], error: null }) })).toMatchObject({ id: 'me' })
    expect(await getMyProfile({ rpc: async () => ({ data: null, error: { message: 'x' } }) })).toBeNull()
  })
})
