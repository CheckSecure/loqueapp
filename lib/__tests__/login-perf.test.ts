import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Login-latency regression guards. The login delay was pre-navigation work on the
 * destination render path (duplicate getUser round-trips, three serial profiles
 * reads, a blocking last_active_at write) plus a redundant router.refresh().
 * These assertions lock in the fixes so they can't silently regress.
 */

const login = readFileSync('app/login/page.tsx', 'utf8')
const layout = readFileSync('app/dashboard/layout.tsx', 'utf8')
const intros = readFileSync('app/dashboard/introductions/page.tsx', 'utf8')
const authUser = readFileSync('lib/supabase/authUser.ts', 'utf8')

describe('login page navigates immediately, does no pre-nav auth work', () => {
  it('navigates straight to the dashboard on success', () => {
    expect(login).toContain("router.push('/dashboard/introductions')")
  })
  it('does NOT call the redundant router.refresh() after push', () => {
    expect(login).not.toMatch(/router\.refresh\(\)/)
  })
  it('does not re-verify the session before navigating (no getUser/getSession/profile fetch)', () => {
    expect(login).not.toMatch(/\.getUser\(\)/)
    expect(login).not.toMatch(/\.getSession\(\)/)
    expect(login).not.toMatch(/from\(['"]profiles['"]\)/)
  })
})

describe('auth is request-deduplicated across layout + page', () => {
  it('exposes a React cache()-wrapped getAuthUser', () => {
    expect(authUser).toMatch(/cache\(/)
    expect(authUser).toMatch(/getUser\(\)/)
  })
  it('the dashboard layout uses the deduped getAuthUser, not its own auth.getUser()', () => {
    expect(layout).toContain('getAuthUser')
    expect(layout).not.toMatch(/supabase\.auth\.getUser\(\)/)
  })
  it('the introductions page (login destination) also uses the deduped getAuthUser', () => {
    expect(intros).toContain('getAuthUser')
    expect(intros).not.toMatch(/supabase\.auth\.getUser\(\)/)
  })
})

describe('dashboard layout removed serial pre-render work', () => {
  it('no longer runs a standalone profile_complete auth-gate query before the fan-out', () => {
    // The onboarding gate now reads from the single fan-out result, not its own
    // pre-fan-out `.select('profile_complete, full_name')` round-trip.
    expect(layout).not.toMatch(/select\(['"]profile_complete, full_name['"]\)/)
  })
  it('the last_active_at write is fire-and-forget (never awaited on the render path)', () => {
    expect(layout).toMatch(/void supabase[\s\S]{0,160}last_active_at/)
    expect(layout).not.toMatch(/await supabase[\s\S]{0,120}last_active_at/)
  })
})

describe('middleware stays lean + secure (no legal/migration/db-loop work)', () => {
  const mw = readFileSync('middleware.ts', 'utf8')
  it('uses the secure getUser (not an unvalidated getSession)', () => {
    expect(mw).toMatch(/auth\.getUser\(\)/)
    expect(mw).not.toMatch(/auth\.getSession\(\)/)
  })
  it('does not perform legal-acceptance or migration-health checks in the hot path', () => {
    expect(mw).not.toMatch(/needsReacceptance|migrationHealth|terms_version_accepted/)
  })
})
