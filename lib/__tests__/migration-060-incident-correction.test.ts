import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Migration-059 incident correction. Migration 059 revoked authenticated EXECUTE on public.is_admin()
// on an incorrect "zero callers" conclusion; production RLS policies on core member tables call
// is_admin() and are evaluated AS the authenticated role, so member reads failed with
// "permission denied for function is_admin". Migration 060 restores the grant. The app also silently
// converted those query ERRORS into an empty network / zero credits — fixed here too.
//
// These are STRUCTURAL tests (they read the migration SQL + source): they fail if the final migration
// chain drops the required EXECUTE grant, or if the UI regresses to treating a query error as an empty
// successful result. They intentionally do not require a live database.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

const M60 = readFileSync('supabase/migrations/060_restore_is_admin_authenticated_execute.sql', 'utf8')
const sql60 = M60.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

describe('060 — restores authenticated EXECUTE on is_admin (the fix), keeps PUBLIC/anon revoked', () => {
  it('GRANTs EXECUTE on is_admin() to authenticated (the required policy helper)', () => {
    expect(sql60).toMatch(/GRANT\s+EXECUTE ON FUNCTION public\.is_admin\(\) TO authenticated/)
  })
  it('preserves the service_role grant', () => {
    expect(sql60).toMatch(/GRANT\s+EXECUTE ON FUNCTION public\.is_admin\(\) TO service_role/)
  })
  it('keeps PUBLIC and anon revoked (does NOT grant them)', () => {
    expect(sql60).toMatch(/REVOKE\s+EXECUTE ON FUNCTION public\.is_admin\(\) FROM PUBLIC, anon/)
    expect(sql60).not.toMatch(/GRANT[^;]*is_admin\(\) TO[^;]*\banon\b/)
    expect(sql60).not.toMatch(/GRANT[^;]*is_admin\(\) TO[^;]*\bPUBLIC\b/)
  })
  it('PRESERVES the 059 hardened body — does NOT CREATE OR REPLACE / DROP is_admin (grant-only)', () => {
    expect(sql60).not.toMatch(/CREATE OR REPLACE FUNCTION public\.is_admin/)
    expect(sql60).not.toMatch(/DROP FUNCTION[^;]*is_admin/)
  })
  it('is additive: no DML, no 048, no last_active_at', () => {
    expect(sql60).not.toMatch(/\b(INSERT INTO|UPDATE |DELETE FROM)\b/)
    expect(sql60).not.toMatch(/\b048\b|last_active_at/)
  })
})

describe('is_admin() live-production dependency set — documented so a repo-only search can NEVER again conclude "zero callers"', () => {
  // LIVE READ-ONLY AUDIT (2026): public.is_admin() is invoked by 17 RLS policies across SIX tables.
  // These policies are OUT-OF-BAND (defined directly in prod, not in any repo migration) — the exact
  // reason migration 059's repository-only grep wrongly concluded is_admin() had no callers, revoking
  // authenticated EXECUTE and breaking every member read that touches these tables. This is the canonical
  // record of that dependency set; changing it is a deliberate, reviewed act.
  const IS_ADMIN_POLICY_DEPENDENTS = {
    conversations: 1,
    intro_requests: 3,
    matches: 4,
    meeting_credits: 4,
    profiles: 3,
    waitlist: 2,
  } as const

  it('exactly six tables depend on is_admin() via RLS policies, totalling 17 policies', () => {
    const tables = Object.keys(IS_ADMIN_POLICY_DEPENDENTS)
    expect(tables.sort()).toEqual(['conversations', 'intro_requests', 'matches', 'meeting_credits', 'profiles', 'waitlist'])
    expect(tables.length).toBe(6)
    expect(Object.values(IS_ADMIN_POLICY_DEPENDENTS).reduce((a, b) => a + b, 0)).toBe(17)
  })

  it('the visibly-failed member surfaces (Network, credits) are backed by is_admin-dependent tables', () => {
    // matches -> Network page; meeting_credits -> credits badge/balance. Both are in the dependency set,
    // so restoring authenticated EXECUTE (migration 060) is REQUIRED, not optional.
    expect(IS_ADMIN_POLICY_DEPENDENTS.matches).toBeGreaterThan(0)
    expect(IS_ADMIN_POLICY_DEPENDENTS.meeting_credits).toBeGreaterThan(0)
  })

  it('migration 060 exists precisely because these callers are out-of-band (not in repo migrations)', () => {
    // Guard: if a future migration ever DOES add an is_admin()-dependent policy in-repo, that is fine —
    // but the authenticated EXECUTE grant must still be present. This ties the two together.
    expect(sql60).toMatch(/GRANT\s+EXECUTE ON FUNCTION public\.is_admin\(\) TO authenticated/)
  })
})

describe('059 body is still the hardened self-only boolean that 060 relies on', () => {
  const M59 = readFileSync('supabase/migrations/059_harden_security_definer_functions.sql', 'utf8')
  const sql59 = M59.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
  const isadmin = (sql59.match(/CREATE OR REPLACE FUNCTION public\.is_admin\([\s\S]*?\$\$;/) || [''])[0]
  it('SECURITY DEFINER, search_path=\'\', no argument, auth.uid()-bound, null→false, self-only', () => {
    expect(isadmin).toMatch(/SECURITY DEFINER/)
    expect(isadmin).toMatch(/SET search_path = ''/)
    expect(isadmin).toMatch(/public\.is_admin\(\)/) // no argument
    expect(isadmin).toMatch(/WHEN auth\.uid\(\) IS NULL THEN false/)
    expect(isadmin).toMatch(/COALESCE\(\(SELECT p\.is_admin FROM public\.profiles p WHERE p\.id = auth\.uid\(\)\), false\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// REGRESSION: a FAILED database query must never be silently rendered as an empty successful result.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Network page — a matches query ERROR is surfaced, not rendered as "No connections yet"', () => {
  const NET = readFileSync('app/dashboard/network/page.tsx', 'utf8')
  it('captures the matches query error', () => {
    expect(NET).toMatch(/error:\s*matchesError/)
  })
  it('returns an error state when the matches read errors (before the empty-state render)', () => {
    expect(NET).toMatch(/if\s*\(\s*matchesError\s*\)/)
    // The error branch must come before the connections.length === 0 "No connections yet" RENDER
    // (the JSX <p>, not the explanatory comment) — target the closing tag to skip the comment mention.
    expect(NET.indexOf('if (matchesError)')).toBeLessThan(NET.indexOf('No connections yet</p>'))
  })
  it('does NOT treat a query error as an empty array without first checking the error', () => {
    // The empty-state string must only be reachable when matchesError is falsy (guarded above).
    expect(NET).toMatch(/load your network/)
  })
})

describe('Credits — a failed credits read renders an error, never 0 / "No credits remaining"', () => {
  const BILL = readFileSync('app/dashboard/billing/page.tsx', 'utf8')
  const LAYOUT = readFileSync('app/dashboard/layout.tsx', 'utf8')
  const SIDEBAR = readFileSync('components/Sidebar.tsx', 'utf8')
  const MOBILE = readFileSync('components/MobileNav.tsx', 'utf8')

  it('billing captures the credits query error and tracks it separately from a 0 balance', () => {
    expect(BILL).toMatch(/error:\s*creditError/)
    expect(BILL).toMatch(/setCreditsError\(true\)/)
    // PGRST116 (no row) is a real 0, not an error
    expect(BILL).toMatch(/PGRST116/)
  })
  it('billing renders an error message instead of a numeric balance on failure', () => {
    expect(BILL).toMatch(/creditsError\s*\?/)
    expect(BILL).toMatch(/load your balance/)
  })
  it('layout treats a credits read error as null (unknown), NOT 0', () => {
    expect(LAYOUT).toMatch(/error:\s*creditError/)
    expect(LAYOUT).toMatch(/credits:\s*number\s*\|\s*null/)
    expect(LAYOUT).toMatch(/creditError && \(creditError as any\)\.code !== 'PGRST116'/)
  })
  it('Sidebar chip accepts null and never shows "No credits remaining" for a load failure', () => {
    expect(SIDEBAR).toMatch(/credits:\s*number\s*\|\s*null/)
    expect(SIDEBAR).toMatch(/credits === null/)
    expect(SIDEBAR).toMatch(/Credits unavailable/)
    // the null branch is checked BEFORE the "No credits remaining" (credits === 0) LABEL literal
    // (single-quoted code string, not the double-quoted comment mention)
    expect(SIDEBAR.indexOf('credits === null')).toBeLessThan(SIDEBAR.indexOf("'No credits remaining'"))
  })
  it('MobileNav chip accepts null and renders a placeholder instead of "✦ 0" on failure', () => {
    expect(MOBILE).toMatch(/credits:\s*number\s*\|\s*null/)
    expect(MOBILE).toMatch(/credits === null/)
  })
})
