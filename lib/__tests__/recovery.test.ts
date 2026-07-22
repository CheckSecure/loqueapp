import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  RecoveryFlow, sanitizeRedirect, classifyVerifyError, isValidOtpType, parseRecoveryParamsFromLocation,
} from '@/lib/auth/recovery'

const makeClient = (impl: (args: any) => Promise<{ error: any }>) => ({ auth: { verifyOtp: vi.fn(impl) } })
const ok = async () => ({ error: null })

afterEach(() => vi.restoreAllMocks())

describe('RecoveryFlow.init — prefetch safety', () => {
  it('the initial GET/init verifies NOTHING (a scanner cannot consume the token)', () => {
    const client = makeClient(ok)
    const flow = new RecoveryFlow(client as any, { token_hash: 'TH', type: 'recovery', next: null })
    const gate = flow.init()
    expect(gate).toEqual({ state: 'ready' })
    expect(client.auth.verifyOtp).not.toHaveBeenCalled() // <-- the whole point
  })

  it('flags missing token / invalid type without verifying', () => {
    const client = makeClient(ok)
    expect(new RecoveryFlow(client as any, { token_hash: null, type: 'recovery' }).init()).toEqual({ state: 'invalid', reason: 'missing_token' })
    expect(new RecoveryFlow(client as any, { token_hash: 'TH', type: 'bogus' }).init()).toEqual({ state: 'invalid', reason: 'invalid_type' })
    expect(client.auth.verifyOtp).not.toHaveBeenCalled()
  })
})

describe('RecoveryFlow.confirm — explicit verification', () => {
  it('verifies exactly once on the deliberate action and redirects to the forced-change page', async () => {
    const client = makeClient(ok)
    const r = await new RecoveryFlow(client as any, { token_hash: 'TH', type: 'recovery', next: null }).confirm()
    expect(client.auth.verifyOtp).toHaveBeenCalledTimes(1)
    expect(client.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'TH', type: 'recovery' })
    expect(r).toEqual({ ok: true, redirect: '/auth/reset-password' })
  })

  it('a reused token fails safely with a "used" message', async () => {
    const client = makeClient(async () => ({ error: { message: 'Token has already been used' } }))
    const r = await new RecoveryFlow(client as any, { token_hash: 'TH', type: 'recovery' }).confirm()
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.kind).toBe('used'); expect(r.message).toMatch(/already been used/i) }
  })

  it('an expired token produces a useful expired message', async () => {
    const client = makeClient(async () => ({ error: { message: 'Email link is invalid or has expired' } }))
    const r = await new RecoveryFlow(client as any, { token_hash: 'TH', type: 'recovery' }).confirm()
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.kind).toBe('expired'); expect(r.message).toMatch(/expired/i) }
  })

  it('does not verify when params are invalid', async () => {
    const client = makeClient(ok)
    const r = await new RecoveryFlow(client as any, { token_hash: null, type: 'recovery' }).confirm()
    expect(r.ok).toBe(false)
    expect(client.auth.verifyOtp).not.toHaveBeenCalled()
  })

  it('honors a safe internal redirect but rejects an external one (open-redirect guard)', async () => {
    const client = makeClient(ok)
    const safe = await new RecoveryFlow(client as any, { token_hash: 'TH', type: 'recovery', next: '/dashboard/reset-password' }).confirm()
    expect(safe).toEqual({ ok: true, redirect: '/dashboard/reset-password' })
    const evil = await new RecoveryFlow(client as any, { token_hash: 'TH', type: 'recovery', next: '//evil.example.com' }).confirm()
    expect(evil).toEqual({ ok: true, redirect: '/auth/reset-password' })
  })
})

describe('sanitizeRedirect — open-redirect prevention', () => {
  it('accepts internal absolute paths', () => {
    expect(sanitizeRedirect('/dashboard')).toBe('/dashboard')
    expect(sanitizeRedirect('/auth/reset-password?x=1')).toBe('/auth/reset-password?x=1')
  })
  it('rejects external / protocol-relative / scheme / backslash / junk', () => {
    for (const bad of ['//evil.com', 'https://evil.com', 'http://x', 'javascript:alert(1)', '/\\evil', 'ftp:/x', 'evilpath', '', null, undefined]) {
      expect(sanitizeRedirect(bad as any)).toBe('/auth/reset-password')
    }
  })
})

describe('parseRecoveryParamsFromLocation — fragment keeps the token off the server', () => {
  it('prefers the fragment over the query string', () => {
    const p = parseRecoveryParamsFromLocation('#token_hash=FRAG&type=magiclink&next=/dashboard', '?token_hash=QUERY&type=recovery')
    expect(p.token_hash).toBe('FRAG')
    expect(p.type).toBe('magiclink')
    expect(p.next).toBe('/dashboard')
  })
  it('falls back to the query when the fragment is empty (resilience)', () => {
    const p = parseRecoveryParamsFromLocation('', '?token_hash=Q&type=recovery')
    expect(p.token_hash).toBe('Q')
    expect(p.type).toBe('recovery')
  })
  it('returns nulls when neither is present', () => {
    expect(parseRecoveryParamsFromLocation('', '').token_hash).toBeNull()
    expect(parseRecoveryParamsFromLocation(null, null).type).toBeNull()
  })
})

describe('classifyVerifyError', () => {
  it('maps messages to categories', () => {
    expect(classifyVerifyError('Token has expired')).toBe('expired')
    expect(classifyVerifyError('already been used')).toBe('used')
    expect(classifyVerifyError('invalid token')).toBe('invalid')
    expect(classifyVerifyError('something else')).toBe('other')
    expect(classifyVerifyError(undefined)).toBe('other')
  })
})

describe('isValidOtpType', () => {
  it('accepts known types, rejects others', () => {
    expect(isValidOtpType('recovery')).toBe(true)
    expect(isValidOtpType('magiclink')).toBe(true)
    expect(isValidOtpType('bogus')).toBe(false)
    expect(isValidOtpType(null)).toBe(false)
  })
})

describe('no secrets in logs', () => {
  it('the recovery flow never writes the token to console', async () => {
    const logs: string[] = []
    for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: any[]) => { logs.push(a.join(' ')) })
    }
    const client = makeClient(async () => ({ error: { message: 'Token has expired' } }))
    const flow = new RecoveryFlow(client as any, { token_hash: 'SUPER_SECRET_TOKEN_HASH', type: 'recovery', next: '/dashboard' })
    flow.init()
    await flow.confirm()
    expect(logs.join('\n')).not.toContain('SUPER_SECRET_TOKEN_HASH')
  })
})
