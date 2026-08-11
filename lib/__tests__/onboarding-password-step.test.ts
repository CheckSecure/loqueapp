import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { onboardingStepList, initialOnboardingStep, resolveOnboardingGate } from '@/lib/onboarding/steps'

// Regression + hardening for the production bug: after a secure reset the user was routed
//   /auth/reset-password → /dashboard/onboarding → dashboard layout redirect → /onboarding
// and /onboarding (OnboardingForm) ALWAYS started at a second "Set your password" step. The gate
// must fail closed and never skip the password step on a lookup error.

describe('onboarding step model', () => {
  it('needsPassword=false → starts at PROFILE, no password step', () => {
    expect(initialOnboardingStep(false)).toBe('profile')
    expect(onboardingStepList(false)).toEqual(['profile', 'preferences'])
  })
  it('needsPassword=true → starts at PASSWORD (legacy preserved)', () => {
    expect(initialOnboardingStep(true)).toBe('password')
    expect(onboardingStepList(true)[0]).toBe('password')
  })
})

describe('resolveOnboardingGate — FAIL CLOSED', () => {
  it('a profile lookup ERROR → gate error (never rendered as password-complete / never skips the step)', () => {
    expect(resolveOnboardingGate({ profile: null, error: { code: '42501' } })).toEqual({ kind: 'error' })
    expect(resolveOnboardingGate({ profile: { profile_complete: false, password_reset_required: true }, error: { message: 'db down' } })).toEqual({ kind: 'error' })
  })
  it('confirmed complete profile → complete', () => {
    expect(resolveOnboardingGate({ profile: { profile_complete: true }, error: null })).toEqual({ kind: 'complete' })
  })
  it('confirmed NO profile (null, no error) → onboard, needsPassword=false', () => {
    expect(resolveOnboardingGate({ profile: null, error: null })).toEqual({ kind: 'onboard', needsPassword: false })
  })
  it('confirmed profile, flag false/null → onboard, needsPassword=false', () => {
    expect(resolveOnboardingGate({ profile: { profile_complete: false, password_reset_required: false }, error: null })).toEqual({ kind: 'onboard', needsPassword: false })
    expect(resolveOnboardingGate({ profile: { profile_complete: false, password_reset_required: null }, error: null })).toEqual({ kind: 'onboard', needsPassword: false })
  })
  it('confirmed legacy profile, flag true, no continuation → onboard, needsPassword=true', () => {
    expect(resolveOnboardingGate({ profile: { profile_complete: false, password_reset_required: true }, error: null })).toEqual({ kind: 'onboard', needsPassword: true })
  })
  it('REFRESH after the legacy onboarding password update (server-confirmed) → needsPassword=false, even with the flag still true', () => {
    expect(resolveOnboardingGate({ profile: { profile_complete: false, password_reset_required: true }, error: null, passwordAlreadySet: true }))
      .toEqual({ kind: 'onboard', needsPassword: false })
  })
})

describe('production route wiring', () => {
  const layout = readFileSync('app/dashboard/layout.tsx', 'utf8')
  const page = readFileSync('app/onboarding/page.tsx', 'utf8')
  const form = readFileSync('components/OnboardingForm.tsx', 'utf8')

  it('the dashboard layout redirects users needing onboarding to /onboarding', () => {
    expect(layout).toMatch(/redirect\('\/onboarding'\)/)
  })
  it('/onboarding uses maybeSingle + the fail-closed resolver + a server-verified continuation cookie', () => {
    expect(page).toMatch(/\.maybeSingle\(\)/)
    expect(page).toContain('resolveOnboardingGate')
    expect(page).toContain('verifyContinuationToken')
    expect(page).toMatch(/gate\.kind === 'error'/)          // fail-closed branch
    expect(page).toMatch(/needsPassword=\{gate\.needsPassword\}/)
  })
  it('OnboardingForm requires needsPassword and derives its initial step from it', () => {
    expect(form).toMatch(/needsPassword: boolean/)            // required, no default
    expect(form).not.toMatch(/needsPassword = false/)
    expect(form).toMatch(/useState<Step>\(initialOnboardingStep\(needsPassword\)\)/)
    expect(form).not.toMatch(/useState<Step>\('password'\)/)
  })
  it('the onboarding password step clears the flag via the SERVER route (no client-authorized clear)', () => {
    expect(form).toContain('/api/auth/complete-reset')       // reuses the server-authorized path
    expect(form).not.toMatch(/\.updateUser\(/)               // no client password update
    // treats ok OR finalize as "password set" so a refresh cannot re-show the form:
    expect(form).toMatch(/data\?\.ok \|\| data\?\.stage === 'finalize'/)
  })
  it('every OnboardingForm call site passes needsPassword explicitly (only one caller)', () => {
    const callers = [page].filter(s => s.includes('<OnboardingForm'))
    expect(callers.length).toBe(1)
    for (const s of callers) expect(s).toMatch(/<OnboardingForm[^>]*needsPassword=/)
  })
})
