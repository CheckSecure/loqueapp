import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { issueContinuationToken, verifyContinuationToken, CONTINUATION_TTL_MS } from '@/lib/auth/resetContinuation'

const prevSecret = process.env.RESET_CONTINUATION_SECRET
const prevSrk = process.env.SUPABASE_SERVICE_ROLE_KEY
beforeEach(() => { process.env.RESET_CONTINUATION_SECRET = 'unit-test-secret'; delete process.env.SUPABASE_SERVICE_ROLE_KEY })
afterAll(() => {
  if (prevSecret === undefined) delete process.env.RESET_CONTINUATION_SECRET; else process.env.RESET_CONTINUATION_SECRET = prevSecret
  if (prevSrk === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevSrk
})

const NOW = 1_000_000

describe('reset continuation token — issue/verify', () => {
  it('a freshly issued token verifies for the same user within the window', () => {
    const t = issueContinuationToken('u1', NOW)!
    expect(verifyContinuationToken(t, 'u1', NOW + 1000)).toBe(true)
  })
  it('is bound to the user — another uid cannot use it', () => {
    const t = issueContinuationToken('u1', NOW)!
    expect(verifyContinuationToken(t, 'u2', NOW + 1000)).toBe(false)
  })
  it('expires after the TTL', () => {
    const t = issueContinuationToken('u1', NOW)!
    expect(verifyContinuationToken(t, 'u1', NOW + CONTINUATION_TTL_MS + 1)).toBe(false)
  })
  it('rejects a tampered signature', () => {
    const t = issueContinuationToken('u1', NOW)!
    expect(verifyContinuationToken(t.slice(0, -2) + 'xx', 'u1', NOW + 1000)).toBe(false)
  })
  it('rejects a tampered payload (uid/exp) whose signature no longer matches', () => {
    const t = issueContinuationToken('u1', NOW)!
    const [, exp, sig] = t.split('.')
    const forged = `u2.${exp}.${sig}`
    expect(verifyContinuationToken(forged, 'u2', NOW + 1000)).toBe(false)
    const longerExp = `u1.${Number(exp) + 10_000_000}.${sig}`
    expect(verifyContinuationToken(longerExp, 'u1', NOW + 1000)).toBe(false)
  })
  it('rejects a client-forged value (attacker has no signing key)', () => {
    expect(verifyContinuationToken(`u1.${NOW + 999999}.deadbeef`, 'u1', NOW + 1000)).toBe(false)
    expect(verifyContinuationToken('1', 'u1', NOW)).toBe(false)
    expect(verifyContinuationToken('', 'u1', NOW)).toBe(false)
    expect(verifyContinuationToken(null, 'u1', NOW)).toBe(false)
  })
  it('fails closed with no signing key configured (cannot issue or verify)', () => {
    delete process.env.RESET_CONTINUATION_SECRET
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    expect(issueContinuationToken('u1', NOW)).toBeNull()
    expect(verifyContinuationToken(`u1.${NOW + 1}.x`, 'u1', NOW)).toBe(false)
  })
})
