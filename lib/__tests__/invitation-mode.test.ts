import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import {
  invitationsMode, canSendInvitation, invitationTestAllowlist,
  activationRemindersEnabled, invitationsEnabled,
  INVITATIONS_PAUSED_MESSAGE, INVITATION_TEST_BLOCKED_MESSAGE,
} from '@/lib/invitations/featureGate'

const prevMode = process.env.INVITATIONS_MODE
const prevList = process.env.INVITATION_TEST_EMAILS
beforeEach(() => { delete process.env.INVITATIONS_MODE; delete process.env.INVITATION_TEST_EMAILS })
afterAll(() => {
  if (prevMode === undefined) delete process.env.INVITATIONS_MODE; else process.env.INVITATIONS_MODE = prevMode
  if (prevList === undefined) delete process.env.INVITATION_TEST_EMAILS; else process.env.INVITATION_TEST_EMAILS = prevList
})

describe('invitationsMode — parser fails safe to off', () => {
  it('unset/empty/malformed/unknown → off', () => {
    expect(invitationsMode()).toBe('off')                                   // unset
    process.env.INVITATIONS_MODE = ''; expect(invitationsMode()).toBe('off')
    process.env.INVITATIONS_MODE = '   '; expect(invitationsMode()).toBe('off')
    process.env.INVITATIONS_MODE = 'enabled'; expect(invitationsMode()).toBe('off') // unknown
    process.env.INVITATIONS_MODE = 'true'; expect(invitationsMode()).toBe('off')    // old boolean not honored
    process.env.INVITATIONS_MODE = 'ON!'; expect(invitationsMode()).toBe('off')     // malformed
  })
  it('recognizes off / test / on case-insensitively', () => {
    process.env.INVITATIONS_MODE = 'off'; expect(invitationsMode()).toBe('off')
    process.env.INVITATIONS_MODE = 'TEST'; expect(invitationsMode()).toBe('test')
    process.env.INVITATIONS_MODE = ' On '; expect(invitationsMode()).toBe('on')
  })
  it('coarse invitationsEnabled = mode !== off; reminders only run in on', () => {
    process.env.INVITATIONS_MODE = 'off'; expect(invitationsEnabled()).toBe(false); expect(activationRemindersEnabled()).toBe(false)
    process.env.INVITATIONS_MODE = 'test'; expect(invitationsEnabled()).toBe(true); expect(activationRemindersEnabled()).toBe(false)
    process.env.INVITATIONS_MODE = 'on'; expect(invitationsEnabled()).toBe(true); expect(activationRemindersEnabled()).toBe(true)
  })
})

describe('invitationTestAllowlist — normalized like login, safe on bad input', () => {
  it('empty / whitespace / commas-only → EMPTY set (no recipients allowed)', () => {
    expect(invitationTestAllowlist().size).toBe(0)
    process.env.INVITATION_TEST_EMAILS = '   '; expect(invitationTestAllowlist().size).toBe(0)
    process.env.INVITATION_TEST_EMAILS = ',, ,'; expect(invitationTestAllowlist().size).toBe(0)
  })
  it('normalizes mixed-case + trailing/leading spaces exactly like login', () => {
    process.env.INVITATION_TEST_EMAILS = '  Test.User@Example.COM , second@x.co  '
    const set = invitationTestAllowlist()
    expect(set.has('test.user@example.com')).toBe(true)
    expect(set.has('second@x.co')).toBe(true)
    expect(set.size).toBe(2)
  })
})

describe('canSendInvitation — per-recipient enforcement', () => {
  it('off → never sends to anyone (even an "allowlisted" address)', () => {
    process.env.INVITATIONS_MODE = 'off'; process.env.INVITATION_TEST_EMAILS = 'a@b.co'
    expect(canSendInvitation('a@b.co')).toBe(false)
  })
  it('test with NO allowlist → sends to nobody', () => {
    process.env.INVITATIONS_MODE = 'test'
    expect(canSendInvitation('a@b.co')).toBe(false)
  })
  it('test → allows EXACTLY the normalized allowlisted address (case/space-insensitive), rejects others', () => {
    process.env.INVITATIONS_MODE = 'test'; process.env.INVITATION_TEST_EMAILS = 'Allow@Test.com'
    expect(canSendInvitation('allow@test.com')).toBe(true)
    expect(canSendInvitation('  ALLOW@TEST.COM ')).toBe(true) // normalized before the check
    expect(canSendInvitation('someone.else@test.com')).toBe(false)
    expect(canSendInvitation('')).toBe(false)
    expect(canSendInvitation(null)).toBe(false)
  })
  it('on → sends to anyone', () => {
    process.env.INVITATIONS_MODE = 'on'
    expect(canSendInvitation('anyone@anywhere.com')).toBe(true)
  })
})

describe('messages contain no address', () => {
  it('paused + test-blocked messages are generic (no email interpolation)', () => {
    expect(INVITATIONS_PAUSED_MESSAGE).not.toMatch(/@/)
    expect(INVITATION_TEST_BLOCKED_MESSAGE).not.toMatch(/@/)
    expect(INVITATION_TEST_BLOCKED_MESSAGE).toMatch(/test mode/i)
  })
})
