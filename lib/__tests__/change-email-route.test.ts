import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { NextResponse } from 'next/server'

// Authorization + the compensated orchestrator are mocked so we can assert the route's gatekeeping
// (admin auth → CSRF → content-type → strict body → rollout gate) WITHOUT any service-role access.
const requireAdmin = vi.fn()
const changeInviteEmail = vi.fn()
vi.mock('@/lib/admin/requireAdmin', () => ({ requireAdmin: () => requireAdmin() }))
vi.mock('@/lib/invitations/changeInviteEmail', async (orig) => ({
  ...(await orig<any>()),
  changeInviteEmail: (...a: any[]) => changeInviteEmail(...a),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/email', () => ({ sendSecureInviteEmail: async () => ({ success: true }) }))

import { POST, GET } from '@/app/api/admin/waitlist/change-email/route'

const WID = 'f565c7e4-def6-44a1-a190-5fcf90f9042a'
const NEW = 'broadbent2@hotmail.com'

const req = (body: any, opts: { throwOnJson?: boolean; headers?: Record<string, string> } = {}) => ({
  json: async () => { if (opts.throwOnJson) throw new Error('bad'); return body },
  headers: new Headers({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(opts.headers ?? {}) }),
}) as any
const allow = () => requireAdmin.mockResolvedValue({ user: { email: 'admin' }, error: null })
const deny = () => requireAdmin.mockResolvedValue({ user: null, error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })

beforeEach(() => {
  requireAdmin.mockReset()
  changeInviteEmail.mockReset()
  changeInviteEmail.mockResolvedValue({ ok: true, state: 'changed_and_sent', changed: true, sent: true, deliveryId: 'd', message: 'ok' })
  process.env.INVITATIONS_MODE = 'on' // gate open unless a test overrides
})

describe('authorization precedes any service-role/orchestrator work', () => {
  it('denies a non-admin BEFORE the orchestrator runs', async () => {
    deny()
    const res = await POST(req({ waitlistId: WID, newEmail: NEW }))
    expect(res.status).toBe(403)
    expect(changeInviteEmail).not.toHaveBeenCalled()
  })
  it('rejects a cross-site request BEFORE auth (Sec-Fetch-Site: cross-site)', async () => {
    allow()
    const res = await POST(req({ waitlistId: WID, newEmail: NEW }, { headers: { 'sec-fetch-site': 'cross-site' } }))
    expect(res.status).toBe(403)
    expect(changeInviteEmail).not.toHaveBeenCalled()
  })
  it('rejects a cross-origin request (Origin host ≠ Host)', async () => {
    allow()
    const res = await POST(req({ waitlistId: WID, newEmail: NEW }, { headers: { origin: 'https://evil.example', host: 'app.andrel.example' } }))
    expect(res.status).toBe(403)
    expect(changeInviteEmail).not.toHaveBeenCalled()
  })
})

describe('strict input validation (admin authorized, gate open)', () => {
  beforeEach(() => allow())
  const rejects = async (body: any, opts: any = {}) => {
    const res = await POST(req(body, opts))
    expect(res.status).toBe(400)
    expect(changeInviteEmail).not.toHaveBeenCalled()
  }
  it('rejects a non-JSON content-type', () => rejects({ waitlistId: WID, newEmail: NEW }, { headers: { 'content-type': 'text/plain' } }))
  it('rejects malformed JSON', () => rejects(undefined, { throwOnJson: true }))
  it('rejects an array body', () => rejects([{ waitlistId: WID, newEmail: NEW }]))
  it('rejects a missing newEmail', () => rejects({ waitlistId: WID }))
  it('rejects a missing waitlistId', () => rejects({ newEmail: NEW }))
  it('rejects extra keys (bulk/cohort shape)', () => rejects({ waitlistId: WID, newEmail: NEW, all: true }))
  it('rejects a bulk ids array', () => rejects({ waitlistId: [WID], newEmail: NEW }))
  it('rejects a malformed waitlist uuid', () => rejects({ waitlistId: 'not-a-uuid', newEmail: NEW }))
  it('rejects a wildcard waitlistId', () => rejects({ waitlistId: '*', newEmail: NEW }))
  it('rejects a non-string newEmail', () => rejects({ waitlistId: WID, newEmail: 123 }))
  it('rejects an empty newEmail', () => rejects({ waitlistId: WID, newEmail: '   ' }))
})

describe('rollout-mode gate blocks before any mutation', () => {
  beforeEach(() => allow())
  it('mode=off → 503 paused, orchestrator not called', async () => {
    process.env.INVITATIONS_MODE = 'off'
    const res = await POST(req({ waitlistId: WID, newEmail: NEW }))
    expect(res.status).toBe(503)
    expect((await res.json()).state).toBe('paused')
    expect(changeInviteEmail).not.toHaveBeenCalled()
  })
  it('mode=test + not allowlisted → 403, orchestrator not called', async () => {
    process.env.INVITATIONS_MODE = 'test'
    process.env.INVITATION_TEST_EMAILS = 'someone-else@x.com'
    const res = await POST(req({ waitlistId: WID, newEmail: NEW }))
    expect(res.status).toBe(403)
    expect(changeInviteEmail).not.toHaveBeenCalled()
  })
})

describe('authorized happy path delegates to the orchestrator with normalized input', () => {
  beforeEach(() => allow())
  it('calls the orchestrator once with the trimmed id + normalized email and returns a coarse, no-store body', async () => {
    const res = await POST(req({ waitlistId: `  ${WID}  `, newEmail: '  BROADBENT2@Hotmail.com ' }))
    expect(changeInviteEmail).toHaveBeenCalledTimes(1)
    expect(changeInviteEmail.mock.calls[0][1]).toEqual({ waitlistId: WID, newEmail: NEW })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['changed', 'message', 'sent', 'state', 'success'])
    // No identity/token leaked in the response.
    expect(JSON.stringify(body)).not.toContain(WID)
    expect(JSON.stringify(body)).not.toContain('@')
  })

  it('maps orchestrator states to the right status codes', async () => {
    const cases: Array<[string, number]> = [
      ['conflict', 409], ['already_activated', 409], ['ambiguous', 409], ['needs_review', 409],
      ['changed_send_uncertain', 202], ['unavailable', 503], ['critical', 500], ['pending', 200],
      ['changed_send_failed', 200], ['already_current', 200],
    ]
    for (const [state, status] of cases) {
      changeInviteEmail.mockResolvedValueOnce({ ok: status < 400, state, changed: false, sent: false, message: 'm' })
      const res = await POST(req({ waitlistId: WID, newEmail: NEW }))
      expect(res.status, state).toBe(status)
    }
  })

  it('GET is 405', async () => {
    expect((await GET()).status).toBe(405)
  })
})

describe('route source guarantees', () => {
  const src = readFileSync('app/api/admin/waitlist/change-email/route.ts', 'utf8')
  it('authorizes before parsing the body and never mints a password', () => {
    expect(src.indexOf('requireAdmin()')).toBeLessThan(src.indexOf('req.json()'))
    expect(src.indexOf('assertSameOrigin(req)')).toBeLessThan(src.indexOf('requireAdmin()'))
    // No password is ever minted/set (the word only appears in comments).
    expect(src).not.toMatch(/generatePassword|temp.?password|password\s*[:=]/i)
    expect(src).toContain("purpose: 'access_resend'") // reuses the tracked resend delivery path
    expect(src).toContain("type: 'recovery'")         // passwordless secure link
  })
  it('changes the existing Auth user with email_confirm:true (no Supabase-generated email) and never rewrites recipient_email', () => {
    expect(src).toContain('email_confirm: true')       // confirm in place → Supabase sends nothing itself
    expect(src).toContain('updateUserById')            // mutates the EXISTING user (no createUser)
    expect(src).not.toMatch(/createUser|signUp/)
    // The only waitlist write sets email; the delivery recipient is never patched here.
    expect(src).not.toMatch(/recipient_email\s*[:=]/)
    // ilike comparisons are wildcard-escaped (literal case-insensitive match).
    expect(src).toContain('likeLiteral(')
  })
})
