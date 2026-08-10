import { describe, it, expect, beforeEach, vi } from 'vitest'

// The activation-reminders cron sends invitation/access emails. While INVITATIONS_ENABLED is
// closed it must send NOTHING, write NO reminder timestamps, and return a neutral paused result.

const state = vi.hoisted(() => ({
  mode: 'off' as 'off' | 'test' | 'on',
  emailCalls: 0,
  dbWrites: [] as any[],
  listUsersCalls: 0,
}))

// Reminders run ONLY in 'on' mode; 'off' and 'test' keep them fully paused.
vi.mock('@/lib/invitations/featureGate', () => ({ activationRemindersEnabled: () => state.mode === 'on' }))
vi.mock('@/lib/email', () => ({
  sendInviteReminder1: async () => { state.emailCalls++; return { success: true } },
  sendInviteReminder2: async () => { state.emailCalls++; return { success: true } },
}))
// Fully chainable, awaitable query builder (order-independent) that resolves to an empty set.
const chain = (): any => new Proxy(() => {}, {
  get: (_t, prop) => {
    if (prop === 'then') return (res: any) => res({ data: [], error: null })
    return () => chain()
  },
})
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: { admin: { listUsers: async () => { state.listUsersCalls++; return { data: { users: [] }, error: null } } } },
    from: () => ({
      select: () => chain(),
      update: (p: any) => { state.dbWrites.push(p); return { eq: async () => ({ error: null }) } },
    }),
  }),
}))

import { GET } from '@/app/api/cron/activation-reminders/route'

const call = () => GET(new Request('http://localhost/api/cron/activation-reminders', { headers: { authorization: 'Bearer test-secret' } }))

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret'
  state.mode = 'off'
  state.emailCalls = 0
  state.dbWrites = []
  state.listUsersCalls = 0
})

describe('activation-reminders cron — runs ONLY in on mode', () => {
  it('rejects an unauthorized caller (401)', async () => {
    const res = await GET(new Request('http://localhost/api/cron/activation-reminders', { headers: { authorization: 'Bearer wrong' } }))
    expect(res.status).toBe(401)
  })
  const pausedCase = (mode: 'off' | 'test') =>
    it(`mode ${mode} → paused, ZERO emails, ZERO timestamp writes, no user enumeration`, async () => {
      state.mode = mode
      const res = await call()
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ paused: true })
      expect(state.emailCalls).toBe(0)     // sends nothing
      expect(state.dbWrites).toHaveLength(0) // never marks a reminder as sent
      expect(state.listUsersCalls).toBe(0) // short-circuits before any work
    })
  pausedCase('off')
  pausedCase('test') // TEST mode keeps reminders COMPLETELY paused
  it('mode on → runs the reminder pass (no longer paused)', async () => {
    state.mode = 'on'
    const res = await call()
    const body = await res.json()
    expect(body.paused).toBeUndefined()
    expect(state.listUsersCalls).toBeGreaterThan(0) // proceeds to enumerate/send
  })
})
