import { describe, it, expect, vi, afterEach } from 'vitest'
import { emitMetric, sanitizeDims, isAllowedMetric, ALLOWED_METRICS } from '@/lib/metrics'

afterEach(() => vi.restoreAllMocks())

describe('sanitizeDims — no secrets in metrics', () => {
  it('drops any dimension whose key looks like a secret', () => {
    const out = sanitizeDims({
      token: 'abc', token_hash: 'x', password: 'p', secret: 's', authorization: 'a',
      cookie: 'c', apiKey: 'k', outcome: 'success', attempt: 2, founding: true,
    })
    expect(out).toEqual({ outcome: 'success', attempt: 2, founding: true })
    expect(Object.keys(out)).not.toContain('token')
    expect(Object.keys(out)).not.toContain('password')
  })
  it('length-caps string values and drops null/undefined/objects', () => {
    const out = sanitizeDims({ big: 'x'.repeat(500), nil: null, obj: { a: 1 } as any })
    expect((out.big as string).length).toBe(80)
    expect('nil' in out).toBe(false)
    expect('obj' in out).toBe(false)
  })
  it('drops URL/email-like values and rejects arrays/nested objects', () => {
    const out = sanitizeDims({ outcome: 'ok', link: 'https://evil.com/x', who: 'a@b.com', arr: [1, 2] as any, obj: { x: 1 } as any })
    expect(out).toEqual({ outcome: 'ok' })
  })
  it('caps the number of dimensions', () => {
    const many: Record<string, unknown> = {}
    for (let i = 0; i < 20; i++) many['d' + i] = i
    expect(Object.keys(sanitizeDims(many)).length).toBeLessThanOrEqual(8)
  })
  it('returns empty for array or non-object input', () => {
    expect(sanitizeDims([1, 2] as any)).toEqual({})
    expect(sanitizeDims(null as any)).toEqual({})
  })
})

describe('isAllowedMetric', () => {
  it('accepts only the defined metric names', () => {
    for (const m of ALLOWED_METRICS) expect(isAllowedMetric(m)).toBe(true)
    expect(isAllowedMetric('arbitrary_event')).toBe(false)
    expect(isAllowedMetric(123)).toBe(false)
  })
})

describe('emitMetric — server path', () => {
  it('logs a structured line with metric name and safe dims, never a secret', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    emitMetric('recovery_verify_reused', { token: 'LEAK_ME', outcome: 'reused' } as any)
    const line = spy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(line).toContain('recovery_verify_reused')
    expect(line).toContain('outcome')
    expect(line).not.toContain('LEAK_ME')
  })
})
