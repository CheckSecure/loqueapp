import { describe, it, expect, beforeEach, vi } from 'vitest'

// ROUTE-LEVEL tests for POST /api/webhooks/resend. The signature primitive (resend.webhooks.verify)
// and the pure event→status/ordering helpers are covered elsewhere; here we pin the ROUTE's
// contract: raw body read once and handed untouched to verify, svix headers forwarded, fail-closed
// on missing secret/headers/invalid signature, idempotent duplicate handling, unknown-event ack,
// RETRYABLE 5xx on durable-store failure, and NO sensitive logging.

const state = vi.hoisted(() => ({
  secret: 'whsec_test',
  verifyReturn: { type: 'email.delivered', messageId: 'm1', createdAt: '2026-01-01T00:00:00Z' } as any,
  verifyCalls: [] as any[],
  applyReturn: 'applied' as 'applied' | 'ignored' | 'duplicate' | 'not_found' | 'error',
  applyThrows: false,
  applyCalls: [] as any[],
}))

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/webhooks/resendVerify', async (orig) => {
  const actual = await (orig() as any)
  return {
    ...actual,
    // Record exactly what the route passes so we can assert raw-body + header forwarding.
    verifyResendWebhook: (rawBody: string, headers: Headers, secret: string) => {
      state.verifyCalls.push({ rawBody, secret, svixId: headers.get('svix-id'), svixTimestamp: headers.get('svix-timestamp'), svixSignature: headers.get('svix-signature') })
      return state.verifyReturn
    },
    // Keep the REAL mapResendEvent so unknown-event handling is genuinely exercised.
    mapResendEvent: actual.mapResendEvent,
  }
})
vi.mock('@/lib/invitations/delivery', () => ({
  applyDeliveryEvent: async (_admin: any, e: any) => { state.applyCalls.push(e); if (state.applyThrows) throw new Error('db down'); return state.applyReturn },
}))

import { POST } from '@/app/api/webhooks/resend/route'

const RAW = JSON.stringify({ type: 'email.delivered', data: { email_id: 'm1' }, created_at: '2026-01-01T00:00:00Z' })
const post = (raw = RAW, headers: Record<string, string> = { 'svix-id': 'svix_1', 'svix-timestamp': '123', 'svix-signature': 'v1,abc' }) =>
  POST(new Request('http://localhost/api/webhooks/resend', { method: 'POST', headers, body: raw }))

beforeEach(() => {
  process.env.RESEND_WEBHOOK_SECRET = 'whsec_test'
  state.secret = 'whsec_test'
  state.verifyReturn = { type: 'email.delivered', messageId: 'm1', createdAt: '2026-01-01T00:00:00Z' }
  state.verifyCalls = []
  state.applyReturn = 'applied'
  state.applyThrows = false
  state.applyCalls = []
})

describe('resend webhook route — verification & fail-closed', () => {
  it('reads the raw body once and passes it UNTOUCHED to verify (exact string, not parsed)', async () => {
    await post()
    expect(state.verifyCalls).toHaveLength(1)
    expect(state.verifyCalls[0].rawBody).toBe(RAW)
  })
  it('forwards the exact svix header trio to verify', async () => {
    await post()
    expect(state.verifyCalls[0]).toMatchObject({ svixId: 'svix_1', svixTimestamp: '123', svixSignature: 'v1,abc' })
  })
  it('passes the configured secret to verify', async () => {
    await post()
    expect(state.verifyCalls[0].secret).toBe('whsec_test')
  })
  it('missing secret → passes empty string (verify fails closed) and the route 401s', async () => {
    delete process.env.RESEND_WEBHOOK_SECRET
    state.verifyReturn = null // a real verify() returns null when secret is empty
    const res = await post()
    expect(res.status).toBe(401)
    expect(state.verifyCalls[0].secret).toBe('')
    expect(state.applyCalls).toHaveLength(0)
  })
  it('invalid signature (verify → null) → 401, nothing applied', async () => {
    state.verifyReturn = null
    const res = await post()
    expect(res.status).toBe(401)
    expect(state.applyCalls).toHaveLength(0)
  })
})

describe('resend webhook route — event handling', () => {
  it('valid event → applies with the mapped status and 200', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(state.applyCalls).toHaveLength(1)
    expect(state.applyCalls[0]).toMatchObject({ svixId: 'svix_1', providerMessageId: 'm1', status: 'delivered' })
  })
  it('unknown event type → acked (200 ignored), nothing applied', async () => {
    state.verifyReturn = { type: 'email.opened', messageId: 'm1', createdAt: null } // not in the status map
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).ignored).toBe(true)
    expect(state.applyCalls).toHaveLength(0)
  })
  it('verified event with no message id → acked, nothing applied', async () => {
    state.verifyReturn = { type: 'email.delivered', messageId: null, createdAt: null }
    const res = await post()
    expect(res.status).toBe(200)
    expect(state.applyCalls).toHaveLength(0)
  })
  it('duplicate delivery (applyDeliveryEvent → "duplicate") → 200 ack, no error', async () => {
    state.applyReturn = 'duplicate'
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).outcome).toBe('duplicate')
  })
  it('not_found delivery → 500 RETRYABLE (message id may not be persisted yet; do not ack-and-lose)', async () => {
    state.applyReturn = 'not_found'
    expect((await post()).status).toBe(500)
  })
  it('invalid/missing provider timestamp → 200 acked, NOTHING applied (no local-time substitution)', async () => {
    state.verifyReturn = { type: 'email.delivered', messageId: 'm1', createdAt: null }
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).ignored).toBe('invalid_timestamp')
    expect(state.applyCalls).toHaveLength(0)
  })
  it('non-date provider timestamp → 200 acked, nothing applied', async () => {
    state.verifyReturn = { type: 'email.delivered', messageId: 'm1', createdAt: 'not-a-date' }
    const res = await post()
    expect(res.status).toBe(200)
    expect(state.applyCalls).toHaveLength(0)
  })
})

describe('resend webhook route — retryable failures', () => {
  it('durable-store error (outcome "error") → 500 so Resend RETRIES', async () => {
    state.applyReturn = 'error'
    const res = await post()
    expect(res.status).toBe(500)
  })
  it('unexpected throw → 500 retryable, not a swallowed 200', async () => {
    state.applyThrows = true
    const res = await post()
    expect(res.status).toBe(500)
  })
})

describe('resend webhook route — no sensitive logging', () => {
  it('never logs the raw body, svix signature, or secret', async () => {
    const logs: string[] = []
    const push = (...a: any[]) => { logs.push(a.map(String).join(' ')) }
    const spyLog = vi.spyOn(console, 'log').mockImplementation(push)
    const spyErr = vi.spyOn(console, 'error').mockImplementation(push)
    state.applyThrows = true // also exercise the error log path
    await post()
    state.applyThrows = false
    await post()
    const blob = logs.join('\n')
    expect(blob).not.toContain(RAW)
    expect(blob).not.toContain('v1,abc')   // svix-signature
    expect(blob).not.toContain('whsec_test') // secret
    spyLog.mockRestore(); spyErr.mockRestore()
  })
})
