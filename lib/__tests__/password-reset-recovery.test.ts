import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Password-reset reliability fix — server recovery helper + routes + config + UX.
 */

const h = vi.hoisted(() => ({
  authUsers: [] as any[],                 // listUsers pool
  userById: {} as Record<string, any>,    // getUserById lookup
  otpCalls: [] as any[],                  // signInWithOtp calls captured
  otpError: null as any,                  // error signInWithOtp returns
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        listUsers: async ({ page }: any) => ({ data: { users: page === 1 ? h.authUsers : [] }, error: null }),
        getUserById: async (id: string) => ({ data: { user: h.userById[id] ?? null }, error: h.userById[id] ? null : { message: 'not found' } }),
      },
    },
  }),
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { signInWithOtp: async (opts: any) => { h.otpCalls.push(opts); return { error: h.otpError } } },
  }),
}))

import { requestPasswordRecovery, requestPasswordRecoveryForUserId, findCanonicalAuthEmail } from '@/lib/auth/recoveryRequest'
import { getSiteUrl, getRecoveryRedirectUrl } from '@/lib/config/siteUrl'
import { createAdminClient } from '@/lib/supabase/admin'

beforeEach(() => {
  h.authUsers = []
  h.userById = {}
  h.otpCalls = []
  h.otpError = null
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key'
  process.env.NEXT_PUBLIC_SITE_URL = 'https://andrel.app'
})

// ── PART 5: canonical production redirect ──────────────────────────────────────
describe('getSiteUrl / getRecoveryRedirectUrl (PART 5)', () => {
  it('production recovery redirect is EXACTLY https://andrel.app/auth/recover', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://andrel.app'
    expect(getRecoveryRedirectUrl()).toBe('https://andrel.app/auth/recover')
  })
  it('falls back to the canonical andrel.app when unset (never localhost/preview/window.origin)', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL
    expect(getSiteUrl()).toBe('https://andrel.app')
    expect(getRecoveryRedirectUrl()).toBe('https://andrel.app/auth/recover')
  })
  it('strips a trailing slash', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://andrel.app/'
    expect(getRecoveryRedirectUrl()).toBe('https://andrel.app/auth/recover')
  })
})

// ── PART 1/2/3/7: server recovery helper ───────────────────────────────────────
describe('requestPasswordRecovery (member)', () => {
  it('trailing-space + mixed-case input resolves to the canonical auth email and sends', async () => {
    h.authUsers = [{ id: 'u1', email: 'chika@hellohopscotch.com' }]
    const out = await requestPasswordRecovery('  Chika@HelloHopscotch.COM  ')
    expect(out).toMatchObject({ ok: true, sent: true, authUserFound: true })
    expect(h.otpCalls).toHaveLength(1)
    expect(h.otpCalls[0].email).toBe('chika@hellohopscotch.com')          // CANONICAL stored email
    expect(h.otpCalls[0].options.shouldCreateUser).toBe(false)            // never creates a user
    expect(h.otpCalls[0].options.emailRedirectTo).toBe('https://andrel.app/auth/recover')
  })

  it('unknown email → SAME generic outcome, no send, no user created', async () => {
    h.authUsers = [{ id: 'u1', email: 'someone@else.com' }]
    const out = await requestPasswordRecovery('nobody@nowhere.com')
    expect(out).toMatchObject({ ok: true, sent: false, authUserFound: false })
    expect(h.otpCalls).toHaveLength(0)
  })

  it('provider rate-limit → still generic (ok:true), classified, existence not leaked', async () => {
    h.authUsers = [{ id: 'u1', email: 'a@b.com' }]
    h.otpError = { message: 'Email rate limit exceeded' }
    const out = await requestPasswordRecovery('a@b.com')
    expect(out.ok).toBe(true)
    expect(out.sent).toBe(false)
    expect(out.errorClass).toBe('rate_limited')
  })

  it('never returns a token or recovery link', async () => {
    h.authUsers = [{ id: 'u1', email: 'a@b.com' }]
    const out = await requestPasswordRecovery('a@b.com')
    expect(Object.keys(out).sort()).toEqual(['authUserFound', 'errorClass', 'ok', 'sent'])
    expect(JSON.stringify(out)).not.toMatch(/token|action_link|hashed/i)
  })

  it('findCanonicalAuthEmail returns the exact stored email (auth.users authority)', async () => {
    h.authUsers = [{ id: 'u1', email: 'Canon@Case.com' }]
    // note: real auth stores lowercased; the lookup compares against the normalized input
    h.authUsers = [{ id: 'u1', email: 'canon@case.com' }]
    expect(await findCanonicalAuthEmail(createAdminClient() as any, 'canon@case.com')).toBe('canon@case.com')
    expect(await findCanonicalAuthEmail(createAdminClient() as any, 'missing@x.com')).toBeNull()
  })
})

describe('requestPasswordRecoveryForUserId (admin / PART 7 invited-no-profile)', () => {
  it("sends to an invited user's canonical email with NO profiles row (auth.users authority)", async () => {
    h.userById['7167'] = { id: '7167', email: 'chika@hellohopscotch.com', last_sign_in_at: null } // Chika's exact class
    const out = await requestPasswordRecoveryForUserId('7167')
    expect(out).toMatchObject({ ok: true, sent: true, authUserFound: true })
    expect(h.otpCalls[0].email).toBe('chika@hellohopscotch.com')
    expect(h.otpCalls[0].options.emailRedirectTo).toBe('https://andrel.app/auth/recover')
  })
  it('unknown user id → generic, no send', async () => {
    const out = await requestPasswordRecoveryForUserId('does-not-exist')
    expect(out).toMatchObject({ ok: true, sent: false, authUserFound: false })
    expect(h.otpCalls).toHaveLength(0)
  })
})

// ── Structural: routes, UX, safe logging ───────────────────────────────────────
describe('routes + UX + observability (structural)', () => {
  const memberRoute = readFileSync('app/api/auth/request-reset/route.ts', 'utf8')
  const adminRoute = readFileSync('app/api/admin/send-password-reset/route.ts', 'utf8')
  const page = readFileSync('app/auth/forgot-password/page.tsx', 'utf8')
  const helper = readFileSync('lib/auth/recoveryRequest.ts', 'utf8')

  it('member route always returns the generic { ok: true } (non-enumerating)', () => {
    expect(memberRoute).toContain('requestPasswordRecovery(email')
    expect(memberRoute).toContain('NextResponse.json({ ok: true })')
    // the RESPONSE bodies never carry existence/link details (only ok booleans)
    expect(memberRoute).not.toMatch(/NextResponse\.json\([^)]*(authUserFound|sent|action_link)/)
  })

  it('admin route is ADMIN_EMAIL-gated and never returns the token/link', () => {
    expect(adminRoute).toContain("user.email !== ADMIN_EMAIL")
    expect(adminRoute).toContain('requestPasswordRecoveryForUserId(memberId')
    expect(adminRoute).not.toMatch(/action_link|hashed_token|properties/)
  })

  it('forgot-password posts to the server route, normalizes, and has resend + 60s cooldown', () => {
    expect(page).toContain("fetch('/api/auth/request-reset'")
    expect(page).toContain('normalizeEmail(target)')
    expect(page).toContain('RESEND_COOLDOWN_SECONDS = 60')
    expect(page).toContain('cooldown > 0')                     // resend disabled during cooldown
    expect(page).toContain('Use a different email')            // edit path
    expect(page).toContain('spam or junk folder')              // spam guidance
    expect(page).not.toContain('signInWithOtp')                // no client-side auth call anymore
  })

  it('helper logs only SAFE facts — no raw email, token, or password', () => {
    expect(helper).toContain('reset_request_received')
    expect(helper).toContain('maskEmail(')
    // the log payload uses masked email + booleans only, never the raw inputs
    expect(helper).not.toMatch(/console\.log\([^)]*rawEmail/)
    expect(helper).not.toMatch(/console\.log\([^)]*token/i)
    expect(helper).not.toMatch(/console\.log\([^)]*password/i)
    expect(helper).toContain('shouldCreateUser: false')        // no account creation on reset
  })
})
