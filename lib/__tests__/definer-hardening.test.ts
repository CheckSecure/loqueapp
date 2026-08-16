import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const M = readFileSync('supabase/migrations/059_harden_security_definer_functions.sql', 'utf8')
const sqlOnly = M.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

const body = (fn: string) =>
  (sqlOnly.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\([\\s\\S]*?\\$\\$;`)) || [''])[0]
const DEL = body('delete_user_account')
const ISADMIN = body('is_admin')
const SYNC = body('sync_email_verification')

describe('059 — the three LIVE functions are SECURITY DEFINER with search_path=\'\'', () => {
  for (const [name, b] of [['delete_user_account', () => DEL], ['is_admin', () => ISADMIN], ['sync_email_verification', () => SYNC]] as const) {
    it(`${name}`, () => {
      expect(b()).toMatch(/SECURITY DEFINER/)
      expect(b()).toMatch(/SET search_path = ''/)
    })
  }
})

describe('059 — handle_new_user() is DROPPED (orphaned), never recreated or granted', () => {
  it('DROPs handle_new_user idempotently', () => {
    expect(sqlOnly).toMatch(/DROP FUNCTION IF EXISTS public\.handle_new_user\(\);/)
  })
  it('never CREATE OR REPLACEs handle_new_user and never grants it', () => {
    expect(sqlOnly).not.toMatch(/CREATE OR REPLACE FUNCTION public\.handle_new_user/)
    expect(sqlOnly).not.toMatch(/GRANT[^;]*public\.handle_new_user/)
    expect(sqlOnly).not.toMatch(/handle_new_user\(\) TO service_role/)
  })
  it('production preflight fact: zero handle_new_user trigger bindings (only sync_email_verification binds)', () => {
    // documented in the migration; the runtime assertion lives in the post-apply verification query.
    expect(M).toMatch(/on_auth_user_email_verified/)
    expect(M).toMatch(/NO trigger binding/i)
  })
  it('no app/lib code or repo migration calls handle_new_user, and provisioning is the live signup path', () => {
    const hits = execSync(
      "grep -rInE \"handle_new_user\" app lib components supabase 2>/dev/null | grep -v '__tests__' | grep -v '059_harden' || true",
      { encoding: 'utf8' },
    ).trim()
    expect(hits).toBe('') // zero references outside migration 059 itself
    // the live server-controlled signup/provisioning path exists
    expect(readFileSync('lib/provisioning.ts', 'utf8')).toMatch(/export async function provisionMemberRecords/)
  })
})

describe('059 — exact privilege matrix (explicit, not relying on existing ACLs)', () => {
  it('the three live functions REVOKE ALL from PUBLIC, anon, authenticated', () => {
    for (const fn of ['delete_user_account', 'is_admin', 'sync_email_verification']) {
      expect(sqlOnly).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(\\) FROM PUBLIC, anon, authenticated`))
    }
  })
  it('delete_user_account: GRANT EXECUTE to authenticated + service_role', () => {
    expect(sqlOnly).toMatch(/GRANT EXECUTE ON FUNCTION public\.delete_user_account\(\) TO authenticated, service_role/)
  })
  it('sync_email_verification: GRANT EXECUTE to service_role ONLY (no authenticated)', () => {
    // NOTE: is_admin is intentionally NOT in this loop. Within the 059 FILE it is (correctly) revoked
    // from authenticated, but that was the migration-059 INCIDENT: production RLS policies on core
    // member tables call public.is_admin() and are evaluated as the authenticated role, so authenticated
    // MUST retain EXECUTE. Migration 060 restores that grant (the final chain). The 059 file itself is
    // immutable; the authenticated-can-execute-is_admin assertions live in migration-060.test.ts.
    for (const fn of ['sync_email_verification']) {
      expect(sqlOnly).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(\\) TO service_role`))
      expect(sqlOnly).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(\\) TO[^;]*authenticated`))
    }
  })
  it('059 FILE (intermediate/incident state) still revokes authenticated on is_admin — corrected by 060', () => {
    // Documents that the bug lives in 059 and is fixed forward, NOT by editing the immutable 059 file.
    expect(sqlOnly).toMatch(/REVOKE ALL ON FUNCTION public\.is_admin\(\) FROM PUBLIC, anon, authenticated/)
    expect(sqlOnly).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.is_admin\(\) TO[^;]*authenticated/)
  })
})

describe('059 — delete_user_account: null-guard, single verified UUID, caller-scoped, exact scope', () => {
  it('captures auth.uid() once and fails closed before any DML', () => {
    expect(DEL).toMatch(/v_uid uuid := auth\.uid\(\)/)
    expect(DEL).toMatch(/IF v_uid IS NULL THEN\s*RAISE EXCEPTION/)
    expect(DEL.indexOf('IF v_uid IS NULL')).toBeLessThan(DEL.indexOf('DELETE FROM'))
  })
  it('every mutation is scoped to v_uid — 11 DELETEs, none unscoped/widened', () => {
    const deletes = DEL.match(/DELETE FROM[\s\S]*?;/g) || []
    expect(deletes.length).toBe(11)
    for (const d of deletes) expect(d).toMatch(/v_uid/)
  })
  it('conversation deletion uses the EXACT production JOIN structure (not match_id IN (...))', () => {
    expect(DEL).toMatch(/DELETE FROM public\.conversations\s*WHERE id IN \(\s*SELECT c\.id\s*FROM public\.conversations c\s*JOIN public\.matches m ON c\.match_id = m\.id\s*WHERE m\.user_a_id = v_uid OR m\.user_b_id = v_uid\s*\)/)
    expect(DEL).not.toMatch(/DELETE FROM public\.conversations\s*WHERE match_id IN/)
  })
  it('preserves the exact caller-scoped condition for each table (a–k)', () => {
    expect(DEL).toMatch(/DELETE FROM public\.messages WHERE sender_id = v_uid/)
    expect(DEL).toMatch(/DELETE FROM public\.matches WHERE user_a_id = v_uid OR user_b_id = v_uid/)
    expect(DEL).toMatch(/DELETE FROM public\.intro_requests WHERE requester_id = v_uid OR target_user_id = v_uid/)
    expect(DEL).toMatch(/DELETE FROM public\.meeting_credits WHERE user_id = v_uid/)
    expect(DEL).toMatch(/DELETE FROM public\.credit_transactions WHERE user_id = v_uid/)
    expect(DEL).toMatch(/DELETE FROM public\.meetings WHERE requester_id = v_uid OR recipient_id = v_uid/)
    expect(DEL).toMatch(/DELETE FROM public\.notifications WHERE user_id = v_uid/)
    expect(DEL).toMatch(/DELETE FROM public\.profiles WHERE id = v_uid/)
    expect(DEL).toMatch(/DELETE FROM public\.waitlist\s*WHERE email = \(SELECT u\.email FROM auth\.users u WHERE u\.id = v_uid\)/)
    expect(DEL).toMatch(/DELETE FROM auth\.users WHERE id = v_uid/)
  })
})

describe('059 — sync_email_verification: trigger, fail-open, first-confirm/change guard, privacy-safe', () => {
  it('RETURNS trigger, updates profiles for NEW.id, fail-open, no NEW.id/SQLERRM in the warning', () => {
    expect(SYNC).toMatch(/RETURNS trigger/)
    expect(SYNC).toMatch(/UPDATE public\.profiles[\s\S]*SET email_verified = true,[\s\S]*email_verified_at = NEW\.email_confirmed_at[\s\S]*WHERE id = NEW\.id/)
    expect(SYNC).toMatch(/EXCEPTION WHEN OTHERS THEN[\s\S]*RAISE WARNING '\[sync_email_verification\] sync failed'[\s\S]*RETURN NEW/)
    expect(SYNC).not.toMatch(/SQLERRM/)
    expect(SYNC).not.toMatch(/RAISE WARNING[^;]*NEW\.id/)
  })
  it('guards on first-confirm OR change (NOT every later auth.users event)', () => {
    expect(SYNC).toMatch(/NEW\.email_confirmed_at IS NOT NULL/)
    expect(SYNC).toMatch(/OLD\.email_confirmed_at IS NULL/)
    expect(SYNC).toMatch(/OLD\.email_confirmed_at\s*!=\s*NEW\.email_confirmed_at/)
    const ifBlock = (SYNC.match(/IF[\s\S]*?THEN/) || [''])[0]
    expect(ifBlock).toMatch(/OLD\.email_confirmed_at/)
    expect(SYNC).not.toMatch(/IF NEW\.email_confirmed_at IS NOT NULL THEN/) // naive form would fire every event
  })
  it('CREATE OR REPLACE (never DROP) → preserves the on_auth_user_email_verified trigger binding', () => {
    expect(sqlOnly).toMatch(/CREATE OR REPLACE FUNCTION public\.sync_email_verification\(\)/)
    expect(sqlOnly).not.toMatch(/DROP FUNCTION IF EXISTS public\.sync_email_verification/)
  })
})

describe('059 — is_admin: self-only boolean, no target UUID, schema-qualified', () => {
  it('null session → false; COALESCE self is_admin; no arg; qualified; no SELECT *', () => {
    expect(sqlOnly).toMatch(/CREATE OR REPLACE FUNCTION public\.is_admin\(\)/)
    expect(ISADMIN).toMatch(/WHEN auth\.uid\(\) IS NULL THEN false/)
    expect(ISADMIN).toMatch(/COALESCE\(\(SELECT p\.is_admin FROM public\.profiles p WHERE p\.id = auth\.uid\(\)\), false\)/)
    expect(ISADMIN).not.toMatch(/\buuid\b/)
    expect(ISADMIN).not.toMatch(/SELECT \*/)
  })
})

describe('059 — schema-qualified, no data changes, no 048', () => {
  it('no unqualified public/auth relation references in the live bodies', () => {
    for (const src of [DEL, ISADMIN, SYNC]) {
      expect(src).not.toMatch(/\bFROM profiles\b/)
      expect(src).not.toMatch(/\bUPDATE profiles\b/)
      expect(src).not.toMatch(/\bFROM users\b/)
      expect(src).not.toMatch(/\bfrom matches\b/i)
    }
  })
  it('three CREATE OR REPLACE + one DROP; no migration-time DML; no 048', () => {
    expect((sqlOnly.match(/CREATE OR REPLACE FUNCTION/g) || []).length).toBe(3)
    expect((sqlOnly.match(/DROP FUNCTION IF EXISTS/g) || []).length).toBe(1)
    const outsideBodies = sqlOnly.replace(/\$\$[\s\S]*?\$\$/g, '')
    expect(outsideBodies).not.toMatch(/\b(INSERT INTO|UPDATE |DELETE FROM)\b/)
    expect(sqlOnly).not.toMatch(/\b048\b|last_active_at/)
  })
})
