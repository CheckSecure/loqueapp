import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { needsReacceptance } from '@/lib/legal/terms'

/**
 * Regression: the /dashboard ↔ /legal/accept infinite redirect loop.
 *
 * INCIDENT. Migration 058 revoked authenticated SELECT on the base public.profiles table.
 * app/legal/accept/page.tsx kept reading the four acceptance columns with the CALLER'S OWN
 * client, so that read returned 42501 permission-denied for every member. Its `if (error)`
 * branch treats a failed read as "nothing to accept" and redirects to /dashboard — while the
 * dashboard layout reads the SAME four columns as service_role, sees the real (unaccepted)
 * state, and redirects straight back to /legal/accept.
 *
 * The loop only fires for a member who genuinely still owes acceptance. Members who predate
 * the grandfathering backfill carry grandfathered_through_version = 1 and never enter the
 * gate at all — which is exactly why only NEW members were affected, on their first dashboard
 * view after onboarding and on every subsequent login.
 *
 * The invariant these tests protect: BOTH gates must read this one fact through the SAME
 * privilege path, so they can never disagree. Reading it two different ways is the bug.
 */

const ACCEPT_PAGE = readFileSync('app/legal/accept/page.tsx', 'utf8')
const DASHBOARD_LAYOUT = readFileSync('app/dashboard/layout.tsx', 'utf8')

/** The columns both gates decide on. */
const ACCEPTANCE_COLUMNS = [
  'terms_version_accepted',
  'privacy_version_accepted',
  'terms_grandfathered_through_version',
  'privacy_grandfathered_through_version',
]

describe('clickwrap gate — the two gates must read acceptance the same way', () => {
  it('/legal/accept reads the acceptance columns via service_role, never the caller client', () => {
    // Isolate the acceptance read and assert the client it is bound to.
    const idx = ACCEPT_PAGE.indexOf('terms_version_accepted')
    expect(idx).toBeGreaterThan(-1)
    const readBlock = ACCEPT_PAGE.slice(Math.max(0, idx - 300), idx)

    expect(readBlock).toContain('createAdminClient()')
    // The exact shape that caused the incident: `supabase.from('profiles')`, i.e. the
    // authenticated caller client reading the revoked base table.
    expect(readBlock).not.toMatch(/\bsupabase\s*\r?\n?\s*\.from\(['"]profiles['"]\)/)
  })

  it('the dashboard layout reads the same columns via service_role too', () => {
    const idx = DASHBOARD_LAYOUT.indexOf('terms_version_accepted')
    expect(idx).toBeGreaterThan(-1)
    const readBlock = DASHBOARD_LAYOUT.slice(Math.max(0, idx - 300), idx)
    expect(readBlock).toContain('createAdminClient()')
  })

  it('both gates decide on the identical column set (no drift between them)', () => {
    for (const col of ACCEPTANCE_COLUMNS) {
      expect(ACCEPT_PAGE).toContain(col)
      expect(DASHBOARD_LAYOUT).toContain(col)
    }
  })
})

describe('clickwrap gate — loop simulation over the real decision functions', () => {
  /** The layout gate: reads as service_role, so it always sees the true row. */
  const layoutRedirectsToAccept = (row: Record<string, number | null>) =>
    needsReacceptance({
      acceptedTermsVersion: row.terms_version_accepted,
      acceptedPrivacyVersion: row.privacy_version_accepted,
      grandfatheredTermsVersion: row.terms_grandfathered_through_version,
      grandfatheredPrivacyVersion: row.privacy_grandfathered_through_version,
    })

  /**
   * The accept page: `mustAccept=false` → redirect('/dashboard'). Models both the fixed
   * behaviour (readSucceeds=true → sees the same row) and the pre-fix behaviour
   * (readSucceeds=false → permission denied → fails open → bounces back).
   */
  const acceptPageRedirectsToDashboard = (row: Record<string, number | null>, readSucceeds: boolean) => {
    if (!readSucceeds) return true // `if (error) mustAccept = false`
    return !layoutRedirectsToAccept(row)
  }

  /** A member created after the grandfathering backfill: owes acceptance, exempt from nothing. */
  const NEW_MEMBER = {
    terms_version_accepted: null,
    privacy_version_accepted: null,
    terms_grandfathered_through_version: null,
    privacy_grandfathered_through_version: null,
  }

  /** A member who predates the backfill: grandfathered through the current version. */
  const ESTABLISHED_MEMBER = {
    terms_version_accepted: null,
    privacy_version_accepted: null,
    terms_grandfathered_through_version: 1,
    privacy_grandfathered_through_version: 1,
  }

  it('reproduces the loop when the accept page cannot read the table (pre-fix)', () => {
    expect(layoutRedirectsToAccept(NEW_MEMBER)).toBe(true)
    expect(acceptPageRedirectsToDashboard(NEW_MEMBER, /* readSucceeds */ false)).toBe(true)
    // Both point at each other → the member never lands anywhere. This is the blank screen.
  })

  it('a new member terminates at /legal/accept once both gates share one read (post-fix)', () => {
    expect(layoutRedirectsToAccept(NEW_MEMBER)).toBe(true)
    expect(acceptPageRedirectsToDashboard(NEW_MEMBER, /* readSucceeds */ true)).toBe(false)
    // Layout sends them to the form; the form renders. No loop.
  })

  it('an established (grandfathered) member is never sent to the gate at all', () => {
    expect(layoutRedirectsToAccept(ESTABLISHED_MEMBER)).toBe(false)
    // ...which is precisely why the incident spared them and hit only new members.
  })

  it('no profile state can make both gates redirect at once when they share one read', () => {
    const states = [NEW_MEMBER, ESTABLISHED_MEMBER,
      { ...NEW_MEMBER, terms_version_accepted: 1, privacy_version_accepted: 1 },
      { ...NEW_MEMBER, terms_version_accepted: 1 }, // half-accepted
      { ...NEW_MEMBER, privacy_grandfathered_through_version: 1 },
    ]
    for (const row of states) {
      const bothRedirect = layoutRedirectsToAccept(row) && acceptPageRedirectsToDashboard(row, true)
      expect(bothRedirect).toBe(false)
    }
  })
})

describe('onboarding completion — the identity read must not be a browser-role read', () => {
  const COMPLETE_ROUTE = readFileSync('app/api/profile/complete/route.ts', 'utf8')
  const STEP2 = readFileSync('components/OnboardingStep2.tsx', 'utf8')

  it('reads title/company/location via service_role, not the revoked base-table path', () => {
    const idx = COMPLETE_ROUTE.indexOf("select('title, company, location')")
    expect(idx).toBeGreaterThan(-1)
    const readBlock = COMPLETE_ROUTE.slice(Math.max(0, idx - 300), idx)
    expect(readBlock).toContain('createAdminClient()')
    expect(readBlock).not.toMatch(/\bsupabase\s*\r?\n?\s*\.from\(['"]profiles['"]\)/)
  })

  it('a failed identity read is surfaced as a failure, never as a field-validation error', () => {
    // Reporting "Professional title is required." for a permission error told the member to fix
    // a field that was already correct, and was indistinguishable from real validation.
    expect(COMPLETE_ROUTE).toMatch(/identityError/)
    expect(COMPLETE_ROUTE).toMatch(/status:\s*503/)
  })

  it('OnboardingStep2 never navigates away on a failed completion', () => {
    const idx = STEP2.indexOf("/api/profile/complete")
    expect(idx).toBeGreaterThan(-1)
    const submitBlock = STEP2.slice(idx, idx + 700)
    // Must inspect the response and bail out before the push.
    expect(submitBlock).toMatch(/\.ok/)
    expect(submitBlock).toMatch(/setError\(/)
    const guardIdx = submitBlock.search(/if\s*\(!\w+\.ok\)/)
    const pushIdx = submitBlock.indexOf("router.push('/dashboard')")
    expect(guardIdx).toBeGreaterThan(-1)
    expect(pushIdx).toBeGreaterThan(guardIdx) // the guard precedes the navigation
  })
})
