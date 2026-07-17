import { describe, it, expect, beforeEach, vi } from 'vitest'

// Shared, resettable state the mocked clients read/write.
const state = vi.hoisted(() => ({
  adminEmail: 'bizdev91@gmail.com',
  entry: { id: 'e1', email: 'Test@X.com', full_name: 'Test', referral_source: null as string | null },
  authUsers: [] as any[],
  hasProfile: false,
  emailResult: { success: true } as { success: boolean; error?: string },
  createUserResult: { data: { user: { id: 'new-id' } }, error: null } as any,
  updateUserResult: { error: null } as { error: { message: string } | null },
  calls: { createUser: 0, updateUserById: 0, emailSent: 0 },
  // Captured to prove the emailed password IS the one persisted to auth.
  captured: { createdPassword: '', resetPassword: '', emailedPassword: '', createdEmail: '', targetedId: '' },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { email: state.adminEmail } } }) },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: state.entry, error: null }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      admin: {
        listUsers: async ({ page }: any) => ({ data: { users: page === 1 ? state.authUsers : [] }, error: null }),
        createUser: async (arg: any) => { state.calls.createUser++; state.captured.createdPassword = arg?.password; state.captured.createdEmail = arg?.email; return state.createUserResult },
        updateUserById: async (id: string, payload: any) => { state.calls.updateUserById++; state.captured.targetedId = id; state.captured.resetPassword = payload?.password; return state.updateUserResult },
      },
    },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.hasProfile ? { id: 'p' } : null, error: null }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}))

vi.mock('@/lib/email', () => ({
  sendInviteEmail: async (_to: string, _name: string, pw: string) => { state.calls.emailSent++; state.captured.emailedPassword = pw; return state.emailResult },
  sendReferralInviteEmail: async (_to: string, _name: string, pw: string) => { state.calls.emailSent++; state.captured.emailedPassword = pw; return state.emailResult },
}))

import { POST } from '@/app/api/admin/send-invite/route'

const post = (body: any) =>
  POST(new Request('http://localhost/api/admin/send-invite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }))

beforeEach(() => {
  state.entry = { id: 'e1', email: 'Test@X.com', full_name: 'Test', referral_source: null }
  state.authUsers = []
  state.hasProfile = false
  state.emailResult = { success: true }
  state.createUserResult = { data: { user: { id: 'new-id' } }, error: null }
  state.updateUserResult = { error: null }
  state.calls = { createUser: 0, updateUserById: 0, emailSent: 0 }
  state.captured = { createdPassword: '', resetPassword: '', emailedPassword: '', createdEmail: '', targetedId: '' }
})

describe('send-invite route — state-aware & idempotent', () => {
  it('first invite creates exactly ONE auth user and sends the access email', async () => {
    const res = await post({ entryId: 'e1', action: 'invite' })
    const data = await res.json()
    expect(state.calls.createUser).toBe(1)
    expect(state.calls.updateUserById).toBe(0)
    expect(state.calls.emailSent).toBe(1)
    expect(data).toMatchObject({ success: true, state: 'invited' })
  })

  it('resend for an invited, NOT-activated user does NOT call createUser (resets password instead)', async () => {
    state.authUsers = [{ id: 'u1', email: 'test@x.com', last_sign_in_at: null }] // case-insensitive match
    state.hasProfile = false
    const res = await post({ entryId: 'e1', action: 'invite' })
    const data = await res.json()
    expect(state.calls.createUser).toBe(0)          // never duplicates auth
    expect(state.calls.updateUserById).toBe(1)      // fresh temp password
    expect(state.calls.emailSent).toBe(1)           // fresh access email
    expect(data).toMatchObject({ success: true, state: 'resent' })
  })

  it('an active member (has profile) is NOT silently reset via a generic Resend', async () => {
    state.authUsers = [{ id: 'u1', email: 'test@x.com', last_sign_in_at: null }]
    state.hasProfile = true // activated
    const res = await post({ entryId: 'e1', action: 'invite' })
    const data = await res.json()
    expect(state.calls.createUser).toBe(0)
    expect(state.calls.updateUserById).toBe(0)      // NOT reset
    expect(state.calls.emailSent).toBe(0)
    expect(data).toMatchObject({ success: false, state: 'active' })
    expect(data.message).toMatch(/already has an active account/i)
  })

  it('an active member CAN be reset via the explicit password_reset action', async () => {
    state.authUsers = [{ id: 'u1', email: 'test@x.com', last_sign_in_at: '2026-01-01' }]
    const res = await post({ entryId: 'e1', action: 'password_reset' })
    const data = await res.json()
    expect(state.calls.createUser).toBe(0)
    expect(state.calls.updateUserById).toBe(1)
    expect(data).toMatchObject({ success: true, state: 'password_reset_sent' })
  })

  it('email delivery failure returns an accurate error (never a false success)', async () => {
    state.emailResult = { success: false, error: 'smtp down' }
    const res = await post({ entryId: 'e1', action: 'invite' })
    const data = await res.json()
    expect(state.calls.createUser).toBe(1)
    expect(data.success).toBeUndefined()
    expect(res.status).toBe(500)
    expect(data.error).toMatch(/Email failed/i)
  })

  // --- Regression coverage for Emilia's failure mode ---------------------------

  it('the password EMAILED is exactly the password PERSISTED (create path)', async () => {
    // Root guarantee: the member can never receive a password that differs from
    // the one stored on the auth user.
    await post({ entryId: 'e1', action: 'invite' })
    expect(state.captured.emailedPassword).toBeTruthy()
    expect(state.captured.emailedPassword).toBe(state.captured.createdPassword)
    expect(state.captured.emailedPassword).toMatch(/^[A-HJ-NP-Za-km-np-z2-9]+$/) // unambiguous
  })

  it('the password EMAILED is exactly the password PERSISTED (reset path)', async () => {
    state.authUsers = [{ id: 'u1', email: 'test@x.com', last_sign_in_at: null }]
    await post({ entryId: 'e1', action: 'invite' })
    expect(state.captured.emailedPassword).toBeTruthy()
    expect(state.captured.emailedPassword).toBe(state.captured.resetPassword)
  })

  it('createUser failure returns 500 and does NOT send an email or claim success', async () => {
    state.createUserResult = { data: null, error: { message: 'db down' } }
    const res = await post({ entryId: 'e1', action: 'invite' })
    const data = await res.json()
    expect(res.status).toBe(500)
    expect(data.success).toBeUndefined()
    expect(state.calls.emailSent).toBe(0)
  })

  it('password-reset (updateUserById) failure returns 500 and does NOT send an email or claim success', async () => {
    state.authUsers = [{ id: 'u1', email: 'test@x.com', last_sign_in_at: null }]
    state.updateUserResult = { error: { message: 'auth admin down' } }
    const res = await post({ entryId: 'e1', action: 'invite' })
    const data = await res.json()
    expect(res.status).toBe(500)
    expect(data.success).toBeUndefined()
    expect(state.calls.emailSent).toBe(0)
    expect(data.error).toMatch(/reset the access password/i)
  })

  it('a mixed-case / whitespace waitlist email targets the EXISTING lowercase auth user (no duplicate)', async () => {
    // Waitlist row has ugly casing + spaces; the real auth user is lowercase.
    state.entry = { id: 'e1', email: '  Test@X.com  ', full_name: 'Test', referral_source: null }
    state.authUsers = [{ id: 'u1', email: 'test@x.com', last_sign_in_at: null }]
    const res = await post({ entryId: 'e1', action: 'invite' })
    const data = await res.json()
    expect(state.calls.createUser).toBe(0)             // did NOT create a second account
    expect(state.calls.updateUserById).toBe(1)
    expect(state.captured.targetedId).toBe('u1')       // reset the existing user
    expect(data).toMatchObject({ success: true, state: 'resent' })
  })

  it('a first invite creates the auth user under the NORMALIZED email', async () => {
    state.entry = { id: 'e1', email: '  NewUser@Example.COM ', full_name: 'New', referral_source: null }
    await post({ entryId: 'e1', action: 'invite' })
    expect(state.captured.createdEmail).toBe('newuser@example.com')
  })
})
