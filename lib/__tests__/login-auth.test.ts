import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { normalizeEmail } from '@/lib/auth/normalizeEmail'

/**
 * Regression coverage for the "invited member cannot log in with the issued
 * temporary password" investigation (Emilia). The auth account itself was
 * healthy; the failure modes were in how the email is normalized at login and
 * how the temporary password is delivered. These guard those surfaces.
 */

describe('shared email normalization (single source of truth, login + invite)', () => {
  it('trims leading/trailing whitespace so a pasted email still matches', () => {
    expect(normalizeEmail('  emilia@example.com ')).toBe('emilia@example.com')
    expect(normalizeEmail('emilia@example.com\n')).toBe('emilia@example.com')
  })
  it('lowercases so mixed-case never targets the wrong / a second account', () => {
    expect(normalizeEmail('Emilia@Example.COM')).toBe('emilia@example.com')
    expect(normalizeEmail('EMILIA@EXAMPLE.COM')).toBe(normalizeEmail('emilia@example.com'))
  })
  it('is null/undefined safe', () => {
    expect(normalizeEmail(null)).toBe('')
    expect(normalizeEmail(undefined)).toBe('')
  })
})

describe('login form normalizes the email and surfaces the real auth error', () => {
  const login = readFileSync('app/login/page.tsx', 'utf8')

  it('normalizes the email before signInWithPassword (same canonical form as the invite side)', () => {
    expect(login).toContain("import { normalizeEmail } from '@/lib/auth/normalizeEmail'")
    expect(login).toMatch(/signInWithPassword\(\{[\s\S]*email:\s*normalizeEmail\(email\)/)
  })
  it('does NOT trim the password (leading/trailing spaces can be significant)', () => {
    expect(login).not.toMatch(/password:\s*\w*\.trim\(\)/)
  })
  it('shows the real authentication error message rather than swallowing it', () => {
    expect(login).toContain('setError(error.message)')
  })
})

describe('middleware: routing gated behind /dashboard; legacy temp-password reset enforced', () => {
  const mw = readFileSync('middleware.ts', 'utf8')
  const gate = readFileSync('lib/auth/dashboardGate.ts', 'utf8')

  it('only runs on /dashboard/* — /login and /auth are never intercepted', () => {
    expect(mw).toMatch(/matcher:\s*\[\s*['"]\/dashboard\/:path\*['"]\s*\]/)
  })
  it('all routing is gated behind a /dashboard path (post-login only), so sign-in is never blocked', () => {
    expect(mw).toContain("request.nextUrl.pathname.startsWith('/dashboard')")
  })
  it('delegates the routing decision to the unit-tested dashboardRedirect helper', () => {
    expect(mw).toContain('dashboardRedirect')
  })
  it('LEGACY password_reset_required accounts are STILL forced to the reset form (enforcement preserved)', () => {
    // The gate lives in the pure helper now, but it must still route flagged accounts to reset.
    expect(gate).toMatch(/password_reset_required[\s\S]*reset-password/)
  })
})
