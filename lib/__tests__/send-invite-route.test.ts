import { describe, it, expect, beforeEach, vi } from 'vitest'

// Shared, resettable state the mocked clients read/write.
const state = vi.hoisted(() => ({
  adminEmail: 'bizdev91@gmail.com',
  entry: { id: 'e1', email: 'Test@X.com', full_name: 'Test', referral_source: null as string | null },
  authUsers: [] as any[],
  hasProfile: false,
  emailResult: { success: true } as { success: boolean; error?: string },
  createUserResult: { data: { user: { id: 'new-id' } }, error: null } as any,
  calls: { createUser: 0, updateUserById: 0, emailSent: 0 },
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
        createUser: async () => { state.calls.createUser++; return state.createUserResult },
        updateUserById: async () => { state.calls.updateUserById++; return { error: null } },
      },
    },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.hasProfile ? { id: 'p' } : null, error: null }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}))

vi.mock('@/lib/email', () => ({
  sendInviteEmail: async () => { state.calls.emailSent++; return state.emailResult },
  sendReferralInviteEmail: async () => { state.calls.emailSent++; return state.emailResult },
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
  state.calls = { createUser: 0, updateUserById: 0, emailSent: 0 }
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
})
