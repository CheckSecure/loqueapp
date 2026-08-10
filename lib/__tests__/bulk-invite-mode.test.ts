import { describe, it, expect, beforeEach, vi } from 'vitest'

// Bulk EXECUTE in test mode must process ONLY allowlisted rows: a non-allowlisted row triggers
// NO Auth lookup, NO waitlist insert, and NO provider send — it is reported skipped.

const norm = (e: string) => (e || '').trim().toLowerCase()
const state = vi.hoisted(() => ({
  mode: 'test' as 'off' | 'test' | 'on',
  allow: new Set<string>(['allow@test.com']),
  sendCalls: [] as any[],
  lookupCalls: [] as string[],
  waitlistInserts: [] as any[],
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: { email: 'bizdev91@gmail.com', id: 'admin' } } }) } }),
}))
// Minimal chainable admin client: categorise reads return empty (everyone is "ready"); waitlist
// insert returns an id; everything else resolves to empty.
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const api: any = {
        select: () => api, eq: () => api, in: async () => ({ data: [] }),
        maybeSingle: async () => ({ data: null }),
        single: async () => (table === 'waitlist' ? { data: { id: 'wl_' + (state.waitlistInserts.length) }, error: null } : { data: null, error: null }),
        insert: (row: any) => { if (table === 'waitlist') state.waitlistInserts.push(row); return api },
        update: () => api,
      }
      return api
    },
  }),
}))
vi.mock('@/lib/invitations', () => ({
  normalizeEmail: (e: string) => (e || '').trim().toLowerCase(),
  lookupAuthUsersByEmail: async (_a: any, email: string) => { state.lookupCalls.push(email); return { count: 0, user: null } },
}))
vi.mock('@/lib/invitations/secureInvite', () => ({
  sendSecureInvite: async (_deps: any, input: any) => { state.sendCalls.push(input); return { ok: true, state: 'invited', sent: true, authUserId: null } },
}))
vi.mock('@/lib/invitations/delivery', () => ({
  claimInviteDelivery: async () => ({ deliveryId: 'd1', isNew: true }),
  markDeliveryAccepted: async () => {}, markDeliveryFailed: async () => {},
}))
vi.mock('@/lib/email', () => ({ sendSecureInviteEmail: async () => ({ success: true, messageId: 'm1' }) }))
vi.mock('@/lib/config/siteUrl', () => ({ getSiteUrl: () => 'https://andrel.app', getRecoveryRedirectUrl: () => 'https://andrel.app/auth/recover' }))
vi.mock('@/lib/invitations/featureGate', () => ({
  invitationsMode: () => state.mode,
  canSendInvitation: (email: string) => state.mode === 'on' || (state.mode === 'test' && state.allow.has((email || '').trim().toLowerCase())),
  INVITATIONS_PAUSED_MESSAGE: 'paused',
}))

import { POST } from '@/app/api/admin/bulk-invite/route'
const post = (body: any) => POST(new Request('http://localhost/api/admin/bulk-invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))

beforeEach(() => {
  state.mode = 'test'
  state.allow = new Set(['allow@test.com'])
  state.sendCalls = []
  state.lookupCalls = []
  state.waitlistInserts = []
})

describe('bulk execute — test-mode allowlist enforcement', () => {
  const TEXT = 'Allow User allow@test.com\nBlock User block@test.com'

  it('preview is allowed in test mode (no sends)', async () => {
    const res = await post({ action: 'preview', text: TEXT })
    expect(res.status).toBe(200)
    expect(state.sendCalls).toHaveLength(0)
  })

  it('execute sends ONLY to the allowlisted row; the non-allowlisted row does NO lookup/insert/send', async () => {
    const res = await post({ action: 'execute', text: TEXT, defaults: {} })
    const body = await res.json()
    // exactly one send, to the allowlisted address
    expect(state.sendCalls).toHaveLength(1)
    expect(state.sendCalls[0].email).toBe('allow@test.com')
    // the blocked row never touched Auth or the waitlist table
    expect(state.lookupCalls).not.toContain('block@test.com')
    expect(state.waitlistInserts.every((r) => norm(r.email) !== 'block@test.com')).toBe(true)
    // and it is reported as skipped
    const blocked = body.results.find((r: any) => norm(r.email) === 'block@test.com')
    expect(blocked.status).toBe('skipped')
    expect(blocked.error).toMatch(/allowlist/i)
  })

  it('execute in OFF mode rejects the whole batch (503, nothing sent)', async () => {
    state.mode = 'off'
    const res = await post({ action: 'execute', text: TEXT, defaults: {} })
    expect(res.status).toBe(503)
    expect(state.sendCalls).toHaveLength(0)
    expect(state.lookupCalls).toHaveLength(0)
  })

  it('execute in ON mode processes every ready row', async () => {
    state.mode = 'on'
    await post({ action: 'execute', text: TEXT, defaults: {} })
    expect(state.sendCalls.map((c) => c.email).sort()).toEqual(['allow@test.com', 'block@test.com'])
  })
})
