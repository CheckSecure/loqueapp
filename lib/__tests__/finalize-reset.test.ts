import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { finalizeResetForUser, destForOutcome } from '@/lib/auth/finalizeReset'

// Fake DB client (service-role, RLS-bypassing) with a per-call queue for the UPDATE result so a
// first-attempt failure can be followed by a retry success. It has NO auth surface at all, so the
// finalize step structurally cannot re-change a password.
function fakeDb(opts: { existing?: any | null; selErr?: any; updateResults?: Array<{ data: any; error: any }> }) {
  let updIdx = 0
  return {
    from: (_t: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.existing ?? null, error: opts.selErr ?? null }) }) }),
      update: (_p: any) => {
        const r = (opts.updateResults && opts.updateResults[updIdx++]) ?? { data: opts.existing ?? null, error: null }
        return { eq: () => ({ select: () => ({ maybeSingle: async () => r }) }) }
      },
    }),
  }
}

describe('finalizeResetForUser — outcomes', () => {
  it('confirmed no-profile invitee (SELECT null, no error) → onboarding', async () => {
    expect(await finalizeResetForUser(fakeDb({ existing: null }), 'u1')).toBe('onboarding')
  })
  it('existing profile, cleared, incomplete → onboarding', async () => {
    expect(await finalizeResetForUser(fakeDb({ existing: { id: 'u1', profile_complete: false }, updateResults: [{ data: { id: 'u1', profile_complete: false }, error: null }] }), 'u1')).toBe('onboarding')
  })
  it('existing profile, cleared, complete → introductions', async () => {
    expect(await finalizeResetForUser(fakeDb({ existing: { id: 'u1', profile_complete: true }, updateResults: [{ data: { id: 'u1', profile_complete: true }, error: null }] }), 'u1')).toBe('introductions')
  })
  it('no userId → error', async () => {
    expect(await finalizeResetForUser(fakeDb({}), '')).toBe('error')
  })

  it('AMBIGUOUS: a confirmed-existing profile whose UPDATE returns zero rows is NOT no-profile → error', async () => {
    expect(await finalizeResetForUser(fakeDb({ existing: { id: 'u1', profile_complete: false }, updateResults: [{ data: null, error: null }] }), 'u1')).toBe('error')
  })
  it('UPDATE permission error on an existing profile → error', async () => {
    expect(await finalizeResetForUser(fakeDb({ existing: { id: 'u1', profile_complete: false }, updateResults: [{ data: null, error: { code: '42501' } }] }), 'u1')).toBe('error')
  })
  it('SELECT error is ambiguous → error, never treated as no-profile', async () => {
    expect(await finalizeResetForUser(fakeDb({ selErr: { code: '42501' } }), 'u1')).toBe('error')
  })

  it('retry: a first-attempt clear failure followed by a retry SUCCEEDS', async () => {
    const db = fakeDb({ existing: { id: 'u1', profile_complete: false }, updateResults: [{ data: null, error: { code: '42501' } }, { data: { id: 'u1', profile_complete: false }, error: null }] })
    expect(await finalizeResetForUser(db, 'u1')).toBe('error')
    expect(await finalizeResetForUser(db, 'u1')).toBe('onboarding')
  })

  it('structural: the finalize module makes no updateUser call', () => {
    expect(readFileSync('lib/auth/finalizeReset.ts', 'utf8')).not.toMatch(/updateUser\(/)
  })
})

describe('destForOutcome', () => {
  it('maps outcomes to routes', () => {
    expect(destForOutcome('introductions')).toBe('/dashboard/introductions')
    expect(destForOutcome('onboarding')).toBe('/dashboard/onboarding')
  })
})
