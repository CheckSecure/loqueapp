import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const requireAdmin = vi.fn()
const runCampaign = vi.fn()
let ccColError: any = null // simulates missing has_additional_recipients column (migration 054 not applied)

vi.mock('@/lib/admin/requireAdmin', () => ({ requireAdmin: () => requireAdmin() }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ limit: async () => ({ error: ccColError }) }) }),
    auth: { admin: {} },
  }),
}))
vi.mock('@/lib/campaigns/jamesNomination', async (orig) => ({
  ...(await orig<any>()),
  runNominationCampaign: (...a: any[]) => runCampaign(...a),
}))
// Keep secure-invite / email / featureGate importable without side effects.
vi.mock('@/lib/email', () => ({ sendNominationInviteEmail: async () => ({ success: true }) }))

import { POST, GET } from '@/app/api/admin/campaigns/james-nomination/route'

const req = (body: any, opts: { throwOnJson?: boolean; headers?: Record<string, string> } = {}) => ({
  json: async () => { if (opts.throwOnJson) throw new Error('bad'); return body },
  headers: new Headers({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(opts.headers ?? {}) }),
}) as any
const allow = () => requireAdmin.mockResolvedValue({ user: { email: 'admin' }, error: null })
const deny = () => requireAdmin.mockResolvedValue({ user: null, error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })

beforeEach(() => {
  requireAdmin.mockReset(); runCampaign.mockReset(); ccColError = null
  runCampaign.mockResolvedValue({ dryRun: true, mode: 'on', campaignKey: 'k', total: 12, summary: {}, recipients: [] })
})

describe('authorization + CSRF precede any work', () => {
  it('non-admin → 403, campaign not run', async () => {
    deny(); const res = await POST(req({ dryRun: true }))
    expect(res.status).toBe(403); expect(runCampaign).not.toHaveBeenCalled()
  })
  it('cross-site → 403', async () => {
    allow(); const res = await POST(req({ dryRun: true }, { headers: { 'sec-fetch-site': 'cross-site' } }))
    expect(res.status).toBe(403); expect(runCampaign).not.toHaveBeenCalled()
  })
})

describe('strict validation', () => {
  beforeEach(() => allow())
  const rejects = async (body: any, opts: any = {}) => { const res = await POST(req(body, opts)); expect(res.status).toBe(400); expect(runCampaign).not.toHaveBeenCalled() }
  it('non-JSON content-type', () => rejects({ dryRun: true }, { headers: { 'content-type': 'text/plain' } }))
  it('malformed JSON', () => rejects(undefined, { throwOnJson: true }))
  it('array body', () => rejects([{ dryRun: true }]))
  it('extra key (no client recipient list)', () => rejects({ dryRun: true, recipients: ['x@y.com'] }))
  it('non-boolean dryRun', () => rejects({ dryRun: 'yes' }))
  it('dry run with an execution selector present → fail closed', () => rejects({ dryRun: true, confirmFullCampaign: true }))
  it('bare { dryRun: false } (no selector) → fail closed, nothing run', () => rejects({ dryRun: false }))
  it('execute with BOTH selectors → fail closed', () => rejects({ dryRun: false, testRecipient: 'bcoffee@sourceamerica.org', confirmFullCampaign: true }))
  it('confirmFullCampaign not exactly true → fail closed', () => rejects({ dryRun: false, confirmFullCampaign: 'yes' }))
  it('confirmFullCampaign false → fail closed', () => rejects({ dryRun: false, confirmFullCampaign: false }))
  it('testRecipient not in the fixed list → fail closed', () => rejects({ dryRun: false, testRecipient: 'stranger@nope.com' }))
  it('testRecipient wildcard / non-string → fail closed', async () => { await rejects({ dryRun: false, testRecipient: '*' }); await rejects({ dryRun: false, testRecipient: ['bcoffee@sourceamerica.org'] }) })
})

describe('execution modes + multi-recipient-column fail-closed + dryRun default', () => {
  beforeEach(() => allow())
  it('EXECUTE (full) with missing has_additional_recipients column (migration 054 not applied) → 503, nothing run', async () => {
    ccColError = { code: '42703', message: 'column does not exist' }
    const res = await POST(req({ dryRun: false, confirmFullCampaign: true }))
    expect(res.status).toBe(503); expect(runCampaign).not.toHaveBeenCalled()
  })
  it('EXECUTE (single test) with missing column → 503, nothing run', async () => {
    ccColError = { code: '42703', message: 'column does not exist' }
    const res = await POST(req({ dryRun: false, testRecipient: 'bcoffee@sourceamerica.org' }))
    expect(res.status).toBe(503); expect(runCampaign).not.toHaveBeenCalled()
  })
  it('DRY-RUN does not require the column (no writes/sends) — still runs, no single-recipient restriction', async () => {
    ccColError = { code: '42703', message: 'column does not exist' }
    const res = await POST(req({ dryRun: true }))
    expect(res.status).toBe(200); expect(runCampaign.mock.calls[0][1]).toEqual({ dryRun: true, only: undefined })
  })
  it('empty body → dryRun defaults TRUE', async () => {
    await POST(req({}))
    expect(runCampaign.mock.calls[0][1]).toEqual({ dryRun: true, only: undefined })
  })
  it('single-recipient test → passes only=<normalized selected email>', async () => {
    await POST(req({ dryRun: false, testRecipient: 'BCoffee@SourceAmerica.org ' }))
    expect(runCampaign.mock.calls[0][1]).toEqual({ dryRun: false, only: 'bcoffee@sourceamerica.org' })
  })
  it('full campaign → dryRun:false, no single-recipient restriction', async () => {
    await POST(req({ dryRun: false, confirmFullCampaign: true }))
    expect(runCampaign.mock.calls[0][1]).toEqual({ dryRun: false, only: undefined })
  })
  it('no-store + coarse passthrough; GET is 405', async () => {
    const res = await POST(req({ dryRun: true }))
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect((await res.json()).success).toBe(true)
    expect((await GET()).status).toBe(405)
  })
})
