import { describe, it, expect } from 'vitest'
import {
  normalizeEmail,
  generateTempPassword,
  resolveInviteAction,
  registrationExistingState,
} from '@/lib/invitations'

describe('normalizeEmail', () => {
  it('trims and lowercases (mixed-case duplicates collapse)', () => {
    expect(normalizeEmail('  Sonali.Gunawardhana@BD.com ')).toBe('sonali.gunawardhana@bd.com')
    expect(normalizeEmail('sonali.gunawardhana@bd.com')).toBe('sonali.gunawardhana@bd.com')
    expect(normalizeEmail(null)).toBe('')
  })
})

describe('generateTempPassword — cryptographically secure', () => {
  it('produces a long, high-entropy, unique password each call', () => {
    const a = generateTempPassword()
    const b = generateTempPassword()
    expect(a.length).toBeGreaterThanOrEqual(20)
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/) // base64url, no Math.random hex slice
  })
})

describe('resolveInviteAction — state-aware invite/resend', () => {
  it('first invite (no auth user) → create exactly one auth user', () => {
    expect(resolveInviteAction({ authExists: false, activated: false, action: 'invite' }))
      .toEqual({ plan: 'create', state: 'invited' })
  })

  it('retry/resend for an invited, NOT-activated user → reset (never createUser)', () => {
    const d = resolveInviteAction({ authExists: true, activated: false, action: 'invite' })
    expect(d.plan).toBe('reset')
    expect(d.plan).not.toBe('create') // no duplicate auth user
    expect(d.state).toBe('resent')
  })

  it('auth user without a profile is treated as not-activated → reset', () => {
    // activated is computed as (signed in OR has profile); no profile + never
    // signed in → activated false → reset path.
    expect(resolveInviteAction({ authExists: true, activated: false, action: 'invite' }).plan).toBe('reset')
  })

  it('active member + generic Resend → NEVER silently reset; returns active', () => {
    const d = resolveInviteAction({ authExists: true, activated: true, action: 'invite' })
    expect(d.plan).toBe('active')
    expect(d.state).toBe('active')
    expect(d.message).toMatch(/already has an active account/i)
  })

  it('explicit password-reset action → reset regardless of activation', () => {
    for (const activated of [true, false]) {
      const d = resolveInviteAction({ authExists: true, activated, action: 'password_reset' })
      expect(d.plan).toBe('password_reset')
      expect(d.state).toBe('password_reset_sent')
    }
  })

  it('is deterministic — double-click/retry yields the same plan (idempotent)', () => {
    const args = { authExists: true, activated: false, action: 'invite' as const }
    expect(resolveInviteAction(args)).toEqual(resolveInviteAction(args))
  })
})

describe('registrationExistingState — re-entry guard (no enumeration)', () => {
  const M = 'You already have an Andrel account or invitation.'

  it('existing invited member (waitlist row) cannot re-enter Pending/Approved', () => {
    expect(registrationExistingState({ waitlistExists: true, profileExists: false, authExists: false }))
      .toEqual({ blocked: true, message: M })
  })
  it('existing active member (profile) cannot re-register', () => {
    expect(registrationExistingState({ waitlistExists: false, profileExists: true, authExists: false }).blocked).toBe(true)
  })
  it('existing auth user (mixed-case duplicate) is blocked', () => {
    expect(registrationExistingState({ waitlistExists: false, profileExists: false, authExists: true }).blocked).toBe(true)
  })
  it('a brand-new email is allowed', () => {
    expect(registrationExistingState({ waitlistExists: false, profileExists: false, authExists: false }))
      .toEqual({ blocked: false, message: '' })
  })
  it('the message is identical for every existing state (no account enumeration)', () => {
    const msgs = [
      registrationExistingState({ waitlistExists: true, profileExists: false, authExists: false }).message,
      registrationExistingState({ waitlistExists: false, profileExists: true, authExists: false }).message,
      registrationExistingState({ waitlistExists: false, profileExists: false, authExists: true }).message,
    ]
    expect(new Set(msgs).size).toBe(1)
  })
})
