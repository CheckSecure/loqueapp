import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Regression guard for the admin nav badge (the yellow pill on the Admin tab).
 *
 * Bug: the dashboard layout counted pending `waitlist` rows with the RLS-scoped
 * user client (`supabase`), which is denied all waitlist rows by RLS, so the badge
 * never reflected pending referrals. Fix: read the pending count through the
 * service-role `adminSupa` client (as the sibling issue_reports query already does).
 *
 * The layout is a JSX server component that this vitest setup can't render
 * (tsconfig jsx=preserve), so — consistent with login-perf.test.ts — these assert
 * on the layout source. They lock BOTH required behaviors and fail on a revert to
 * `supabase.from('waitlist')`.
 */
const layout = readFileSync('app/dashboard/layout.tsx', 'utf8')

// Isolate the "Admin badge" IIFE so assertions are scoped to that block.
const start = layout.indexOf('// Admin badge')
const adminBlock = layout.slice(start, layout.indexOf('})(),', start) + 5)

describe('admin nav badge count — reads pending waitlist through the service-role admin client', () => {
  it('locates the Admin badge block', () => {
    expect(start).toBeGreaterThan(-1)
    expect(adminBlock).toContain('waitlist')
    expect(adminBlock).toContain('issue_reports')
  })

  it('counts pending waitlist rows through the ADMIN client (adminSupa), not the RLS-scoped user client', () => {
    // The pending-waitlist count goes through the service-role client…
    expect(adminBlock).toMatch(/adminSupa\.from\('waitlist'\)[\s\S]*\.eq\('status',\s*'pending'\)/)
    // …and NOT through the RLS-scoped user client (the exact bug).
    expect(adminBlock).not.toContain("supabase.from('waitlist')")
    expect(layout).not.toContain("supabase.from('waitlist')") // nowhere in the file
  })

  it('a non-admin gets NO admin badge count (block short-circuits to 0)', () => {
    expect(adminBlock).toMatch(/if \(!isAdmin\) return 0/)
  })

  it('issue_reports logic is unchanged (still adminSupa, status=new) and summed with waitlist', () => {
    expect(adminBlock).toMatch(/adminSupa\.from\('issue_reports'\)[\s\S]*\.eq\('status',\s*'new'\)/)
    expect(adminBlock).toContain('(wl ?? 0) + (iss ?? 0)')
  })
})
