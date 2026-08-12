import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// Mock the admin guard + the shared generator so we can assert authorization ordering and that
// the endpoint performs NO direct writes (it only delegates to the deployed generator).
const requireAdmin = vi.fn()
const generateReciprocalBatchForMember = vi.fn()
vi.mock('@/lib/admin/requireAdmin', () => ({ requireAdmin: () => requireAdmin() }))
vi.mock('@/lib/generate-recommendations', () => ({ generateReciprocalBatchForMember: (...a: any[]) => generateReciprocalBatchForMember(...a) }))

import { POST, GET } from '@/app/api/admin/recommendations/recover-onboarding/route'

const STEPHEN = 'd11d1c98-e016-497f-9308-e5a4f3caa146'
const req = (body: any, opts: { throwOnJson?: boolean; headers?: Record<string, string> } = {}) => ({
  json: async () => { if (opts.throwOnJson) throw new Error('bad'); return body },
  headers: new Headers({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(opts.headers ?? {}) }),
}) as any
const allow = () => requireAdmin.mockResolvedValue({ user: { email: 'admin' }, error: null })
const deny = () => requireAdmin.mockResolvedValue({ user: null, error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })

beforeEach(() => { requireAdmin.mockReset(); generateReciprocalBatchForMember.mockReset() })

describe('POST /api/admin/recommendations/recover-onboarding — authorization', () => {
  it('denies a non-admin BEFORE any generator/service-role access', async () => {
    deny()
    const res = await POST(req({ userId: STEPHEN }))
    expect(res.status).toBe(403)
    expect(generateReciprocalBatchForMember).not.toHaveBeenCalled() // never reached the generator/service-role
  })
})

describe('strict single-UUID validation (admin authorized)', () => {
  beforeEach(() => allow())
  const rejects = async (body: any, throwJson = false) => {
    const res = await POST(req(body, { throwOnJson: throwJson }))
    expect(res.status).toBe(400)
    expect(generateReciprocalBatchForMember).not.toHaveBeenCalled()
  }
  it('rejects malformed JSON', () => rejects(undefined, true))
  it('rejects a missing userId', () => rejects({}))
  it('rejects an array body', () => rejects([STEPHEN]))
  it('rejects an array of ids', () => rejects({ userId: [STEPHEN, STEPHEN] }))
  it('rejects multiple comma/space-separated ids', () => rejects({ userId: `${STEPHEN}, ${STEPHEN}` }))
  it('rejects a wildcard', () => rejects({ userId: '*' }))
  it('rejects a malformed uuid', () => rejects({ userId: 'not-a-uuid' }))
  it('rejects a non-string userId', () => rejects({ userId: 123 }))
  it('rejects extra keys (cohort/bulk request)', () => rejects({ userId: STEPHEN, all: true }))
  it('rejects a bulk "userIds" field', () => rejects({ userIds: [STEPHEN] }))
})

describe('exactly one member is processed via the shared generator', () => {
  beforeEach(() => allow())
  it('invokes generateReciprocalBatchForMember once with (uuid, "onboarding") and returns a privacy-safe result', async () => {
    generateReciprocalBatchForMember.mockResolvedValue({ count: 2, considered: 2, outcome: 'created', retryable: false, rpcCalls: 2 })
    const res = await POST(req({ userId: STEPHEN }))
    expect(res.status).toBe(200)
    expect(generateReciprocalBatchForMember).toHaveBeenCalledTimes(1)
    expect(generateReciprocalBatchForMember).toHaveBeenCalledWith(STEPHEN, 'onboarding')
    const body = await res.json()
    expect(body).toEqual({ success: true, outcome: 'created', created: 2, retryable: false })
  })
  it('trims surrounding whitespace but still accepts exactly one uuid', async () => {
    generateReciprocalBatchForMember.mockResolvedValue({ count: 0, considered: 0, outcome: 'empty_pool', retryable: true, rpcCalls: 0 })
    const res = await POST(req({ userId: `  ${STEPHEN}  ` }))
    expect(generateReciprocalBatchForMember).toHaveBeenCalledWith(STEPHEN, 'onboarding')
    expect((await res.json()).outcome).toBe('empty_pool')
  })

  it('response exposes ONLY outcome/counts — no uuid, email, or identity', async () => {
    generateReciprocalBatchForMember.mockResolvedValue({ count: 1, considered: 3, outcome: 'created', retryable: false, rpcCalls: 3 })
    const body = await (await POST(req({ userId: STEPHEN }))).json()
    expect(Object.keys(body).sort()).toEqual(['created', 'outcome', 'retryable', 'success'])
    expect(JSON.stringify(body)).not.toContain(STEPHEN)      // no uuid leaked
    expect(JSON.stringify(body)).not.toMatch(/@|considered|rpcCalls/i) // no email; internal counts not surfaced
  })

  it('each of the retryable/terminal outcomes is reported verbatim', async () => {
    for (const outcome of ['created', 'noop_at_capacity', 'empty_pool', 'capacity', 'no_compatible_candidate', 'ineligible', 'transient_error'] as const) {
      generateReciprocalBatchForMember.mockResolvedValue({ count: outcome === 'created' ? 1 : 0, considered: 0, outcome, retryable: true, rpcCalls: 0 })
      const body = await (await POST(req({ userId: STEPHEN }))).json()
      expect(body.outcome).toBe(outcome)
    }
  })
})

describe('request security (CSRF / method / content-type / no-store)', () => {
  it('rejects a cross-site request BEFORE auth/generator (Sec-Fetch-Site: cross-site)', async () => {
    allow()
    const res = await POST(req({ userId: STEPHEN }, { headers: { 'sec-fetch-site': 'cross-site' } }))
    expect(res.status).toBe(403)
    expect(generateReciprocalBatchForMember).not.toHaveBeenCalled()
  })
  it('rejects a cross-origin request (Origin host ≠ Host)', async () => {
    allow()
    const res = await POST(req({ userId: STEPHEN }, { headers: { origin: 'https://evil.example', host: 'app.andrel.example', 'sec-fetch-site': 'same-origin' } }))
    expect(res.status).toBe(403)
    expect(generateReciprocalBatchForMember).not.toHaveBeenCalled()
  })
  it('rejects a non-JSON content-type (blocks HTML form CSRF)', async () => {
    allow()
    const res = await POST(req({ userId: STEPHEN }, { headers: { 'content-type': 'application/x-www-form-urlencoded' } }))
    expect(res.status).toBe(400)
    expect(generateReciprocalBatchForMember).not.toHaveBeenCalled()
  })
  it('GET is not allowed (405) and never processes anything', async () => {
    const res = await GET()
    expect(res.status).toBe(405)
  })
  it('successful responses set Cache-Control: no-store', async () => {
    allow()
    generateReciprocalBatchForMember.mockResolvedValue({ count: 1, outcome: 'created', retryable: false, considered: 1, rpcCalls: 1 })
    const res = await POST(req({ userId: STEPHEN }))
    expect(res.headers.get('cache-control')).toContain('no-store')
  })
})

describe('endpoint performs no writes / notifications (delegation only)', () => {
  it('the route source contains no direct table inserts, email, or notification calls', () => {
    const src = require('node:fs').readFileSync('app/api/admin/recommendations/recover-onboarding/route.ts', 'utf8')
    expect(src).not.toMatch(/\.from\(|\.insert\(|\.upsert\(|sendEmail|sendMail|createNotification|notify/i)
    expect(src).toContain("generateReciprocalBatchForMember(trimmed, 'onboarding')") // sole action
    // authorization precedes any parsing/generation
    expect(src.indexOf('requireAdmin()')).toBeLessThan(src.indexOf('req.json()'))
    // audit log carries no identifiers
    expect(src).not.toMatch(/admin-recover-onboarding[\s\S]{0,120}(userId|email|trimmed|body\.)/)
  })
})
