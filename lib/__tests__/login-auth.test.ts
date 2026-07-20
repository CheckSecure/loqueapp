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

describe('invite email delivers a clean, copy-safe password', () => {
  const email = readFileSync('lib/email.ts', 'utf8')

  it('interpolates the password inline in <code> with NO surrounding whitespace/newline', () => {
    // A password wrapped by indentation/newlines inside <code> can be copied
    // with stray whitespace, which then fails an (un-trimmed) password login.
    expect(email).toMatch(/<code[^>]*>\$\{tempPassword\}<\/code>/)
    expect(email).not.toMatch(/<code[^>]*>\s*\n\s*\$\{tempPassword\}/)
  })

  it('sendInviteEmail states the login email, links to the canonical www login, and tells the user to ignore prior links', () => {
    // Isolate the sendInviteEmail body so assertions target the resend/recovery email.
    const body = email.slice(email.indexOf('export async function sendInviteEmail'), email.indexOf('export async function sendReferralInviteEmail'))
    expect(body).toContain('<strong>Email:</strong> ${escapeHtml(toEmail)}') // correct login email
    expect(body).toContain('https://www.andrel.app/login')                    // canonical www destination
    expect(body).not.toMatch(/href="https:\/\/andrel\.app\/login"/)           // no bare (non-www) host
    expect(body).toMatch(/disregard them|ignore/i)                            // disregard prior magic/reset links
  })

  it('neither invite email links to the bare andrel.app/login host', () => {
    expect(email).not.toContain('href="https://andrel.app/login"')
  })
})

describe('middleware: password_reset_required does NOT block initial authentication', () => {
  const mw = readFileSync('middleware.ts', 'utf8')

  it('only runs on /dashboard/* — /login and /auth are never intercepted', () => {
    expect(mw).toMatch(/matcher:\s*\[\s*['"]\/dashboard\/:path\*['"]\s*\]/)
  })
  it('the reset-password redirect is gated behind a /dashboard path (post-login only)', () => {
    // The forced password change is an in-dashboard step; it cannot prevent the
    // sign-in itself, so an invited user can always authenticate first.
    expect(mw).toContain("request.nextUrl.pathname.startsWith('/dashboard')")
    expect(mw).toMatch(/password_reset_required[\s\S]*reset-password/)
  })
})
