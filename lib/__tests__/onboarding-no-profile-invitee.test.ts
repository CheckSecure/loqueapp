import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveOnboardingGate, selfProfileFromRpc, type OnboardingProfileLite } from '@/lib/onboarding/steps'

const PAGE = readFileSync('app/onboarding/page.tsx', 'utf8')

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// REGRESSION: a valid authenticated, email-confirmed invitee with NO profile row (waitlist=invited, a
// live session, but no public.profiles row — the expected pre-onboarding state) must reach /onboarding
// — never the "We couldn't load your account" error.
//
// ROOT CAUSE: app/onboarding/page.tsx read base public.profiles via the AUTHENTICATED server client.
// Migration 058 revoked authenticated SELECT on public.profiles, so that read returned permission-denied
// (an ERROR) for the confirmed no-profile invitee, and the fail-closed gate rendered it as a load
// failure. The fix reads the self row via the get_my_profile() RPC (SETOF → array of 0/1 rows), where
// ZERO rows is a confirmed-absent profile (not an error, not PGRST116).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('selfProfileFromRpc — get_my_profile SETOF contract: zero rows is confirmed-absent, NOT an error', () => {
  it('an empty array (no profile row) → null (confirmed absent), never throws', () => {
    expect(selfProfileFromRpc([])).toBeNull()
  })
  it('a one-row array → that row', () => {
    expect(selfProfileFromRpc([{ profile_complete: false }])).toEqual({ profile_complete: false })
  })
  it('null/undefined → null; a bare object (non-array) → itself', () => {
    expect(selfProfileFromRpc(null)).toBeNull()
    expect(selfProfileFromRpc(undefined)).toBeNull()
    expect(selfProfileFromRpc({ profile_complete: true })).toEqual({ profile_complete: true })
  })
})

describe('gate over the RPC result — correct state classification', () => {
  // Simulates the page: profile = selfProfileFromRpc(rpcData); gate = resolveOnboardingGate({profile, error})
  const gateFor = (rpcData: any, error: unknown, passwordAlreadySet = false) =>
    resolveOnboardingGate({
      profile: selfProfileFromRpc<OnboardingProfileLite>(rpcData),
      error,
      passwordAlreadySet,
    })

  it('authenticated + confirmed + NO profile (rows=[], no error) → onboarding, NO error, no password step', () => {
    expect(gateFor([], null)).toEqual({ kind: 'onboard', needsPassword: false })
  })
  it('existing INCOMPLETE profile → onboarding', () => {
    expect(gateFor([{ profile_complete: false, password_reset_required: false }], null)).toEqual({ kind: 'onboard', needsPassword: false })
  })
  it('existing COMPLETE profile → dashboard (complete)', () => {
    expect(gateFor([{ profile_complete: true }], null)).toEqual({ kind: 'complete' })
  })
  it('genuine RPC/permission/auth FAILURE → explicit retryable error (fail closed)', () => {
    expect(gateFor(null, { code: '42501', message: 'permission denied for function get_my_profile' })).toEqual({ kind: 'error' })
    expect(gateFor([], { message: 'network' })).toEqual({ kind: 'error' }) // error dominates even with rows present
  })
  it('confirmed ABSENCE is never a load failure; a DB error is never confirmed absence', () => {
    expect(gateFor([], null).kind).toBe('onboard')  // absence → onboard, not error
    expect(gateFor(null, { message: 'db down' }).kind).toBe('error') // error → error, not onboard
  })
  it('legacy temp-password profile still gates the password step (unless already set)', () => {
    expect(gateFor([{ profile_complete: false, password_reset_required: true }], null)).toEqual({ kind: 'onboard', needsPassword: true })
    expect(gateFor([{ profile_complete: false, password_reset_required: true }], null, true)).toEqual({ kind: 'onboard', needsPassword: false })
  })
})

describe('app/onboarding/page.tsx — reads self via get_my_profile, no base-profiles read/mutation', () => {
  it('reads the self gate fields via the get_my_profile() RPC', () => {
    expect(PAGE).toMatch(/supabase\.rpc\('get_my_profile'\)/)
    expect(PAGE).toMatch(/selfProfileFromRpc/)
  })
  it('does NOT read base public.profiles via the authenticated client', () => {
    expect(PAGE).not.toMatch(/\.from\(\s*['"]profiles['"]\s*\)/)
  })
  it('does NOT use .single() on the RPC (which would PGRST116-error on a no-profile invitee)', () => {
    expect(PAGE).not.toMatch(/get_my_profile'\)[\s\S]{0,40}\.single\(\)/)
  })
  it('creates NO profile via an authenticated base-profiles mutation (server-authorized path only)', () => {
    expect(PAGE).not.toMatch(/\.from\(\s*['"]profiles['"]\s*\)\s*\.\s*(insert|upsert|update)/)
  })
  it('fails safely on no session (redirect to /login) and fail-closes to a retryable error on gate error', () => {
    expect(PAGE).toMatch(/if \(!user\) redirect\('\/login'\)/)
    expect(PAGE).toMatch(/gate\.kind === 'error'.*OnboardingUnavailable|OnboardingUnavailable/)
    expect(PAGE).toMatch(/We couldn.t load your account/)
  })
})
