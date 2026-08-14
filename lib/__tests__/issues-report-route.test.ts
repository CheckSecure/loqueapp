import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mocks — issues/report uses getUser (server client), an admin client for the active check + insert,
// the rate limiter, and the admin-alert email.
let user: any = { id: 'u1', email: 'u1@x.com' }
let accountStatus = 'active'
let rateStatus: 'allowed' | 'over_limit' | 'error' = 'allowed'
const insertSpy = vi.fn(async (_row?: any): Promise<any> => ({ error: null }))
const emailSpy = vi.fn(async (..._a: any[]): Promise<any> => ({ success: true }))
const rateSpy = vi.fn(async (..._a: any[]): Promise<any> => ({ status: rateStatus, retryAfterSeconds: 42 }))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (t: string) => {
      if (t === 'profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { account_status: accountStatus } }) }) }) }
      if (t === 'issue_reports') return { insert: (row: any) => insertSpy(row) }
      return {}
    },
  }),
}))
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: (...a: any[]) => rateSpy(...a) }))
vi.mock('@/lib/email', () => ({ sendAdminAlertEmail: (...a: any[]) => emailSpy(...a), escapeHtml: (s: any) => String(s ?? '') }))

import { POST } from '@/app/api/issues/report/route'

const req = (body: any, opts: { origin?: boolean; ct?: string } = {}) => ({
  headers: new Headers({
    'content-type': opts.ct ?? 'application/json',
    ...(opts.origin === false ? { 'sec-fetch-site': 'cross-site' } : { 'sec-fetch-site': 'same-origin' }),
  }),
  json: async () => body,
}) as any

beforeEach(() => {
  user = { id: 'u1', email: 'u1@x.com' }; accountStatus = 'active'; rateStatus = 'allowed'
  insertSpy.mockClear(); emailSpy.mockClear(); rateSpy.mockClear()
})

describe('issues/report — P1-5 hardening', () => {
  it('cross-origin → 403, no insert, no email', async () => {
    const res = await POST(req({ report_text: 'hi' }, { origin: false }))
    expect(res.status).toBe(403)
    expect(insertSpy).not.toHaveBeenCalled(); expect(emailSpy).not.toHaveBeenCalled()
  })
  it('unauthenticated → 401', async () => {
    user = null
    const res = await POST(req({ report_text: 'hi' }))
    expect(res.status).toBe(401); expect(insertSpy).not.toHaveBeenCalled()
  })
  it('inactive account → 403, no insert/email', async () => {
    accountStatus = 'deactivated'
    const res = await POST(req({ report_text: 'hi' }))
    expect(res.status).toBe(403); expect(insertSpy).not.toHaveBeenCalled(); expect(emailSpy).not.toHaveBeenCalled()
  })
  it('extra key → 400, no insert/email', async () => {
    const res = await POST(req({ report_text: 'hi', evil: 1 }))
    expect(res.status).toBe(400); expect(insertSpy).not.toHaveBeenCalled()
  })
  it('empty report_text → 400', async () => {
    const res = await POST(req({ report_text: '   ' }))
    expect(res.status).toBe(400)
  })
  it('over rate limit → 429 + Retry-After, NO insert, NO email', async () => {
    rateStatus = 'over_limit'
    const res = await POST(req({ report_text: 'hi' }))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('42')
    expect(insertSpy).not.toHaveBeenCalled(); expect(emailSpy).not.toHaveBeenCalled()
  })
  it('FAIL CLOSED: limiter error/timeout/malformed → 503 (+Retry-After), NO insert, NO email — never 429', async () => {
    rateStatus = 'error'
    const res = await POST(req({ report_text: 'hi' }))
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('42')
    expect(insertSpy).not.toHaveBeenCalled(); expect(emailSpy).not.toHaveBeenCalled()
  })
  it('report_text is capped to 4000 chars before insert', async () => {
    await POST(req({ report_text: 'x'.repeat(10000) }))
    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect((insertSpy.mock.calls[0][0] as any).report_text.length).toBe(4000)
  })
  it('happy path → 200, exactly one insert + one email; user_id/email from session not body', async () => {
    const res = await POST(req({ report_text: 'real issue', user_id: 'SPOOF', user_email: 'spoof@x.com' } as any))
    // extra keys user_id/user_email are rejected by strict validation → 400
    expect(res.status).toBe(400)
    const ok = await POST(req({ report_text: 'real issue' }))
    expect(ok.status).toBe(200)
    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect((insertSpy.mock.calls[0][0] as any).user_id).toBe('u1')
    expect(emailSpy).toHaveBeenCalledTimes(1)
  })
})
