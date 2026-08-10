import { describe, it, expect, beforeEach, vi } from 'vitest'

// The route now delegates the secure, passwordless flow to sendSecureInvite; this suite
// verifies the route's ORCHESTRATION (auth gate, transition guard, invited_at gating, neutral
// states, password_reset routing). The secure mechanism itself is covered by secure-invite.test.ts.

const state = vi.hoisted(() => ({
  adminEmail: 'bizdev91@gmail.com',
  mode: 'on' as 'off' | 'test' | 'on',
  allowlisted: true,
  entry: { id: 'e1', email: 'Test@X.com', full_name: 'Test', status: 'approved', referral_source: null as string | null },
  result: { ok: true, state: 'invited', sent: true } as any,
  lookup: { count: 1, user: { id: 'u1', last_sign_in_at: null } } as any,
  recovery: { ok: true, sent: true } as any,
  waitlistUpdates: [] as any[],
  capturedDeps: null as any,
  capturedInput: null as any,
  generateLinkCalls: [] as any[],
  generateLinkError: false,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { email: state.adminEmail, id: 'admin' } } }) },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: state.entry, error: null }) }) }),
      update: (payload: any) => { state.waitlistUpdates.push(payload); return { eq: async () => ({ error: null }) } },
    }),
  }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({ update: () => ({ eq: async () => ({ error: null }) }), select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    auth: { admin: { generateLink: async (arg: any) => { state.generateLinkCalls.push(arg); return state.generateLinkError ? { data: null, error: { message: 'boom' } } : { data: { properties: { hashed_token: 'ht' }, user: { id: 'u1' } }, error: null } } } },
  }),
}))
vi.mock('@/lib/invitations/secureInvite', () => ({ sendSecureInvite: async (deps: any, input: any) => { state.capturedDeps = deps; state.capturedInput = input; return state.result } }))
vi.mock('@/lib/invitations', () => ({ normalizeEmail: (e: string) => (e || '').trim().toLowerCase(), lookupAuthUsersByEmail: async () => state.lookup }))
vi.mock('@/lib/auth/recoveryRequest', () => ({ requestPasswordRecoveryForUserId: async () => state.recovery }))
vi.mock('@/lib/config/siteUrl', () => ({ getSiteUrl: () => 'https://andrel.app', getRecoveryRedirectUrl: () => 'https://andrel.app/auth/recover' }))
vi.mock('@/lib/analytics/recommendationEvents', () => ({ logRecommendationEvent: () => {} }))
vi.mock('@/lib/email', () => ({ sendSecureInviteEmail: async () => ({ success: true, messageId: 'm1' }) }))
vi.mock('@/lib/invitations/delivery', () => ({
  claimInviteDelivery: async () => ({ deliveryId: 'd1', isNew: true }),
  markDeliveryAccepted: async () => {},
  markDeliveryFailed: async () => {},
}))
vi.mock('@/lib/invitations/featureGate', () => ({
  invitationsMode: () => state.mode,
  canSendInvitation: () => state.mode === 'on' || (state.mode === 'test' && state.allowlisted),
  INVITATIONS_PAUSED_MESSAGE: 'paused',
  INVITATION_TEST_BLOCKED_MESSAGE: 'test mode — not allowlisted',
}))

import { POST } from '@/app/api/admin/send-invite/route'

const post = (body: any) =>
  POST(new Request('http://localhost/api/admin/send-invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))

beforeEach(() => {
  state.adminEmail = 'bizdev91@gmail.com'
  state.mode = 'on'
  state.allowlisted = true
  state.entry = { id: 'e1', email: 'Test@X.com', full_name: 'Test', status: 'approved', referral_source: null }
  state.result = { ok: true, state: 'invited', sent: true }
  state.lookup = { count: 1, user: { id: 'u1', last_sign_in_at: null } }
  state.recovery = { ok: true, sent: true }
  state.waitlistUpdates = []
  state.capturedDeps = null
  state.capturedInput = null
  state.generateLinkCalls = []
  state.generateLinkError = false
})

describe('send-invite route — secure, passwordless orchestration', () => {
  it('rejects a non-admin (401)', async () => {
    state.adminEmail = 'nope@x.com'
    expect((await post({ entryId: 'e1' })).status).toBe(401)
  })
  it('404 when the entry is missing', async () => {
    state.entry = null as any
    expect((await post({ entryId: 'e1' })).status).toBe(404)
  })
  it('409 for a blocked transition (pending → invited)', async () => {
    state.entry = { ...state.entry, status: 'pending' }
    expect((await post({ entryId: 'e1' })).status).toBe(409)
  })
  it('mode OFF → 503 paused, ZERO Auth/DB/email side effects (never a password fallback)', async () => {
    state.mode = 'off'
    const res = await post({ entryId: 'e1' })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ state: 'paused' })
    expect(state.waitlistUpdates).toHaveLength(0)      // no DB write
    expect(state.capturedInput).toBeNull()             // orchestrator (claim/generate/send) never invoked
    expect(state.generateLinkCalls).toHaveLength(0)    // no Auth mutation / link generation
  })
  it('mode TEST, recipient NOT allowlisted → 403 neutral, ZERO Auth/DB/email side effects', async () => {
    state.mode = 'test'; state.allowlisted = false
    const res = await post({ entryId: 'e1' })
    expect(res.status).toBe(403)
    expect((await res.json()).state).toBe('not_allowlisted')
    expect(state.waitlistUpdates).toHaveLength(0)
    expect(state.capturedInput).toBeNull()             // gate runs BEFORE the orchestrator
    expect(state.generateLinkCalls).toHaveLength(0)
  })
  it('mode TEST, recipient allowlisted → proceeds (orchestrator invoked)', async () => {
    state.mode = 'test'; state.allowlisted = true
    const res = await post({ entryId: 'e1' })
    expect(res.status).toBe(200)
    expect(state.capturedInput).not.toBeNull()
  })
  it('password_reset stays available even in mode OFF (documented separate path)', async () => {
    state.mode = 'off'
    const res = await post({ entryId: 'e1', action: 'password_reset' })
    expect(await res.json()).toMatchObject({ success: true, state: 'password_reset_sent' })
  })
  it('pending (in-flight / within window) → 200 neutral do-not-resend, no invited_at', async () => {
    state.result = { ok: true, state: 'pending', sent: false, message: 'do not resend' }
    const res = await post({ entryId: 'e1' })
    expect(res.status).toBe(200)
    expect((await res.json()).state).toBe('pending')
    expect(state.waitlistUpdates.some((u) => 'invited_at' in u)).toBe(false)
  })
  it('unavailable (claim could not persist) → 503 fail-closed, no invited_at', async () => {
    state.result = { ok: false, state: 'unavailable', sent: false, message: 'delivery tracking unavailable' }
    const res = await post({ entryId: 'e1' })
    expect(res.status).toBe(503)
    expect((await res.json()).state).toBe('unavailable')
    expect(state.waitlistUpdates.some((u) => 'invited_at' in u)).toBe(false)
  })
  it('uncertain send → 202 retryable, no invited_at', async () => {
    state.result = { ok: false, state: 'uncertain', sent: false, message: 'uncertain' }
    const res = await post({ entryId: 'e1' })
    expect(res.status).toBe(202)
    expect(state.waitlistUpdates.some((u) => 'invited_at' in u)).toBe(false)
  })
  it('needs_review (past retry window) → 409, no invited_at, requires explicit new attempt', async () => {
    state.result = { ok: false, state: 'needs_review', sent: false, message: 'past the safe retry window' }
    const res = await post({ entryId: 'e1' })
    expect(res.status).toBe(409)
    expect((await res.json()).state).toBe('needs_review')
    expect(state.waitlistUpdates.some((u) => 'invited_at' in u)).toBe(false)
  })
  it('force flag is forwarded into the orchestrator input (explicit new attempt)', async () => {
    await post({ entryId: 'e1', force: true })
    expect(state.capturedInput?.force).toBe(true)
  })
  it('first invite ACCEPTED → success + stamps invited_at exactly once', async () => {
    state.result = { ok: true, state: 'invited', sent: true }
    const res = await post({ entryId: 'e1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, state: 'invited' })
    const stamped = state.waitlistUpdates.filter((u) => 'invited_at' in u)
    expect(stamped).toHaveLength(1)
    expect(stamped[0].status).toBe('invited')
  })
  it('access-resend (existing inactive) → success, does NOT stamp invited_at', async () => {
    state.result = { ok: true, state: 'link_sent', sent: true }
    const res = await post({ entryId: 'e1' })
    expect((await res.json()).state).toBe('link_sent')
    expect(state.waitlistUpdates.some((u) => 'invited_at' in u)).toBe(false)
  })
  it('ACTIVE account → neutral 200, no invited_at, no false success', async () => {
    state.result = { ok: false, state: 'active', sent: false, message: 'already active' }
    const res = await post({ entryId: 'e1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: false, state: 'active' })
    expect(state.waitlistUpdates).toHaveLength(0)
  })
  it('AMBIGUOUS/duplicate → 409 hard-stop, no write', async () => {
    state.result = { ok: false, state: 'ambiguous', sent: false, message: 'manual review' }
    const res = await post({ entryId: 'e1' })
    expect(res.status).toBe(409)
    expect(state.waitlistUpdates).toHaveLength(0)
  })
  it('send FAILURE → 500, retryable, NO invited_at (never a false sent state)', async () => {
    state.result = { ok: false, state: 'error', sent: false, message: 'safe to retry' }
    const res = await post({ entryId: 'e1' })
    expect(res.status).toBe(500)
    expect(state.waitlistUpdates.some((u) => 'invited_at' in u)).toBe(false)
  })
  it('explicit password_reset → secure recovery link (no temp password), state password_reset_sent', async () => {
    const res = await post({ entryId: 'e1', action: 'password_reset' })
    expect(await res.json()).toMatchObject({ success: true, state: 'password_reset_sent' })
  })
  it('password_reset with no account → 409 no_account', async () => {
    state.lookup = { count: 0, user: null }
    const res = await post({ entryId: 'e1', action: 'password_reset' })
    expect(res.status).toBe(409)
    expect((await res.json()).state).toBe('no_account')
  })
})

describe('send-invite route — founding-member metadata (no password created/emailed)', () => {
  it('markAsFounding + first invite → generateLink(invite) carries data.markAsFounding, recovery does NOT', async () => {
    await post({ entryId: 'e1', markAsFounding: true })
    // The captured deps let us exercise the route's real generateLink closure.
    await state.capturedDeps.generateLink('invite', 'x@y.com')
    await state.capturedDeps.generateLink('recovery', 'x@y.com')
    const invite = state.generateLinkCalls.find((c) => c.type === 'invite')
    const recovery = state.generateLinkCalls.find((c) => c.type === 'recovery')
    expect(invite.options.data).toEqual({ markAsFounding: true }) // seeds user_metadata at creation
    expect(recovery.options.data).toBeUndefined()                 // resend never rewrites metadata
  })
  it('without markAsFounding → invite link carries NO founding metadata', async () => {
    await post({ entryId: 'e1' })
    await state.capturedDeps.generateLink('invite', 'x@y.com')
    const invite = state.generateLinkCalls.find((c) => c.type === 'invite')
    expect(invite.options.data).toBeUndefined()
  })
  it('generateLink failure surfaces as a throw → orchestrator marks failed and sends NO email', async () => {
    await post({ entryId: 'e1', markAsFounding: true })
    // The metadata write (part of generateLink) cannot half-succeed: an error must throw so the
    // orchestrator's catch path records a failure rather than emailing "setup ready".
    state.generateLinkError = true
    await expect(state.capturedDeps.generateLink('invite', 'x@y.com')).rejects.toThrow()
  })
})
